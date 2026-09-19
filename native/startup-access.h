#pragma once
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <functional>
#include <utility>
#include <cstring>

namespace startup {
class Handle {
 public:
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (valid()) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};

inline std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  GetTokenInformation(token, kind, nullptr, 0, &bytes);
  if (!bytes) return {};
  std::vector<BYTE> data(bytes);
  if (!GetTokenInformation(token, kind, data.data(), bytes, &bytes)) return {};
  return data;
}

// Model Chromium's USER_RESTRICTED_SAME_ACCESS startup read token. This is a
// diagnostic impersonation token only; it never changes Electron's sandbox.
// Flags=0: do not bypass AppLocker/SRP or restrict only writes.
class ReadToken {
 public:
  Handle token;
  DWORD error = ERROR_SUCCESS;
  explicit ReadToken(bool lowIntegrity = true) {
    Handle original;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY,
                          &original.value)) { error = GetLastError(); return; }
    auto user = tokenInfo(original.value, TokenUser);
    auto groups = tokenInfo(original.value, TokenGroups);
    if (user.empty() || groups.empty()) { error = GetLastError(); return; }
    std::vector<SID_AND_ATTRIBUTES> restrictions;
    restrictions.push_back({ reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, 0 });
    auto list = reinterpret_cast<TOKEN_GROUPS*>(groups.data());
    for (DWORD i = 0; i < list->GroupCount; ++i)
      if (!(list->Groups[i].Attributes & SE_GROUP_INTEGRITY))
        restrictions.push_back({ list->Groups[i].Sid, 0 });
    Handle restricted;
    if (!CreateRestrictedToken(original.value, 0, 0, nullptr, 0, nullptr,
        static_cast<DWORD>(restrictions.size()), restrictions.data(), &restricted.value)) {
      error = GetLastError(); return;
    }
    if (!DuplicateTokenEx(restricted.value, TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_ADJUST_DEFAULT,
        nullptr, SecurityImpersonation, TokenImpersonation, &token.value)) {
      error = GetLastError(); return;
    }
    if (lowIntegrity) {
      BYTE sid[SECURITY_MAX_SID_SIZE]; DWORD size = sizeof(sid);
      if (!CreateWellKnownSid(WinLowLabelSid, nullptr, sid, &size)) { error = GetLastError(); return; }
      TOKEN_MANDATORY_LABEL label = { { sid, SE_GROUP_INTEGRITY } };
      if (!SetTokenInformation(token.value, TokenIntegrityLevel, &label,
          sizeof(label) + GetLengthSid(sid))) { error = GetLastError(); return; }
    }
  }
};

struct ReadResult { DWORD error = 0; const wchar_t* stage = L"ok"; };

inline ReadResult readFile(const std::wstring& path, bool executable = false) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | (executable ? GENERIC_EXECUTE : 0),
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file.valid()) return { GetLastError(), L"open" };
  LARGE_INTEGER size = {};
  if (!GetFileSizeEx(file.value, &size)) return { GetLastError(), L"size" };
  if (!size.QuadPart) return { ERROR_FILE_INVALID, L"empty" };
  Handle mapping(CreateFileMappingW(file.value, nullptr, PAGE_READONLY, 0, 0, nullptr));
  if (!mapping.valid()) return { GetLastError(), L"mapping" };
  void* view = MapViewOfFile(mapping.value, FILE_MAP_READ, 0, 0, 1);
  if (!view) return { GetLastError(), L"map-view" };
  UnmapViewOfFile(view);
  return {};
}

inline ReadResult restrictedRead(ReadToken& probe, const std::wstring& path, bool executable = false) {
  if (probe.error || !probe.token.valid()) return { probe.error ? probe.error : ERROR_INVALID_HANDLE, L"token" };
  Handle previous;
  if (!OpenThreadToken(GetCurrentThread(), TOKEN_IMPERSONATE | TOKEN_QUERY, TRUE, &previous.value)
      && GetLastError() != ERROR_NO_TOKEN) return { GetLastError(), L"previous-token" };
  if (!SetThreadToken(nullptr, probe.token.value)) return { GetLastError(), L"impersonate" };
  ReadResult result = readFile(path, executable);
  const BOOL restored = previous.valid() ? SetThreadToken(nullptr, previous.value) : RevertToSelf();
  // Never continue with an unexpected thread identity after an access probe.
  if (!restored) TerminateProcess(GetCurrentProcess(), GetLastError());
  return result;
}

inline std::wstring finalPath(HANDLE file) {
  DWORD size = GetFinalPathNameByHandleW(file, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!size) return {};
  std::vector<wchar_t> buffer(size + 1);
  DWORD result = GetFinalPathNameByHandleW(file, buffer.data(), static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!result || result >= buffer.size()) return {};
  return std::wstring(buffer.data(), result);
}

struct CheckResult { DWORD error = 0; std::wstring file; std::wstring detail; unsigned repaired = 0; };
using Log = std::function<void(const std::wstring&)>;
struct Resource { const wchar_t* path; const char* sha256; bool executable = false; };

inline bool hashMatches(HANDLE file, const char* expected) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  bool matches = false;
  if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0) {
    BYTE buffer[65536], digest[32]; DWORD count = 0;
    bool ok = true;
    while (ok) {
      if (!ReadFile(file, buffer, sizeof(buffer), &count, nullptr)) { ok = false; break; }
      if (!count) break;
      if (BCryptHashData(hash, buffer, count, 0) < 0) ok = false;
    }
    if (ok && BCryptFinishHash(hash, digest, sizeof(digest), 0) >= 0) {
      static const char digits[] = "0123456789abcdef";
      std::string text;
      for (BYTE value : digest) { text += digits[value >> 4]; text += digits[value & 15]; }
      matches = text == expected;
    }
    BCryptDestroyHash(hash);
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return matches;
}

inline bool sameAcl(PACL left, PACL right) {
  return left && right && left->AclSize == right->AclSize && !memcmp(left, right, left->AclSize);
}

// Only a hash-matched shipped resource failing the restricted token probe may
// gain read access (plus execute for compiled-in runtime DLLs). Never recurse,
// remove an ACE, grant write, change ownership or edit parents/user data.
inline DWORD repairRead(const std::wstring& root, const Resource& resource,
                        ReadToken& probe, const Log& log) {
  const std::wstring relative = resource.path;
  const std::wstring path = root + L"\\" + relative;
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL | WRITE_DAC,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) return GetLastError();
  BY_HANDLE_FILE_INFORMATION info = {};
  if (!GetFileInformationByHandle(file.value, &info)) return GetLastError();
  if (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED)
      || info.nNumberOfLinks != 1) return ERROR_NOT_SUPPORTED;
  const auto actual = finalPath(file.value);
  if (actual.empty() || _wcsicmp(actual.c_str(), path.c_str()) != 0) return ERROR_BAD_PATHNAME;
  if (!hashMatches(file.value, resource.sha256)) return ERROR_INVALID_DATA;
  PACL oldAcl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &oldAcl, nullptr, &descriptor);
  if (status) return status;
  if (!oldAcl) { LocalFree(descriptor); return ERROR_INVALID_ACL; }
  // An explicit allow must not override inherited deny or conditional policy.
  for (DWORD index = 0; index < oldAcl->AceCount; ++index) {
    void* ace = nullptr;
    if (!GetAce(oldAcl, index, &ace) || static_cast<ACE_HEADER*>(ace)->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      LocalFree(descriptor); return ERROR_ACCESS_DISABLED_BY_POLICY;
    }
  }
  BYTE sid[SECURITY_MAX_SID_SIZE];
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
  if (!InitializeSid(sid, &authority, 2)) {
    status = GetLastError(); LocalFree(descriptor); return status;
  }
  *GetSidSubAuthority(sid, 0) = 2;
  *GetSidSubAuthority(sid, 1) = 2; // ALL RESTRICTED APPLICATION PACKAGES, read only.
  EXPLICIT_ACCESSW entry = {};
  entry.grfAccessPermissions = FILE_GENERIC_READ | (resource.executable ? FILE_GENERIC_EXECUTE : 0);
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entry.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
  PACL newAcl = nullptr;
  status = SetEntriesInAclW(1, &entry, oldAcl, &newAcl);
  if (!status) status = SetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, newAcl, nullptr);
  if (!status) {
    const auto verify = restrictedRead(probe, path, resource.executable);
    status = verify.error;
    if (status) {
      PACL current = nullptr; PSECURITY_DESCRIPTOR snapshot = nullptr;
      DWORD rollback = GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &current, nullptr, &snapshot);
      if (!rollback && sameAcl(current, newAcl)) rollback = SetSecurityInfo(file.value, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION, nullptr, nullptr, oldAcl, nullptr);
      else if (!rollback) rollback = ERROR_RETRY; // Preserve concurrent administrator changes.
      if (snapshot) LocalFree(snapshot);
      log(L"startup-access rollback file=" + relative + L" error=" + std::to_wstring(rollback));
      if (rollback) status = rollback;
    } else log(L"startup-access repaired file=" + relative + (resource.executable ? L" grant=S-1-15-2-2:read-execute" : L" grant=S-1-15-2-2:read"));
  }
  if (newAcl) LocalFree(newAcl);
  LocalFree(descriptor);
  return status;
}

inline CheckResult checkResources(const std::wstring& directory, const std::vector<Resource>& files,
                                 bool repair, const Log& log) {
  Handle root(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!root.valid()) return { GetLastError(), directory, L"directory" };
  const auto canonical = finalPath(root.value);
  if (canonical.empty()) return { GetLastError(), directory, L"directory-path" };
  ReadToken probe;
  if (probe.error) {
    log(L"startup-access probe-unavailable error=" + std::to_wstring(probe.error));
    // A failed probe setup is not proof of unreadable files; do not edit ACLs.
    return { probe.error, L"", L"probe-unavailable" };
  }
  unsigned repaired = 0;
  for (const auto& resource : files) {
    const std::wstring relative = resource.path;
    const auto path = canonical + L"\\" + relative;
    auto normal = readFile(path, resource.executable);
    if (normal.error) return { normal.error, relative, normal.stage, repaired };
    auto checked = restrictedRead(probe, path, resource.executable);
    if (!checked.error) continue;
    if (std::wstring(checked.stage) == L"token" || std::wstring(checked.stage) == L"previous-token"
        || std::wstring(checked.stage) == L"impersonate")
      return { checked.error, relative, L"probe-unavailable", repaired };
    log(L"startup-access denied file=" + relative + L" stage=" + checked.stage + L" error=" + std::to_wstring(checked.error));
    if (repair && checked.error == ERROR_ACCESS_DENIED && std::wstring(checked.stage) == L"open") {
      DWORD fixed = repairRead(canonical, resource, probe, log);
      if (!fixed) { ++repaired; continue; }
      return { fixed, relative, L"repair-denied", repaired };
    }
    return { checked.error, relative, checked.stage, repaired };
  }
  log(L"startup-access ready checked=" + std::to_wstring(files.size()) + L" repaired=" + std::to_wstring(repaired));
  return { 0, L"", L"ready", repaired };
}
} // namespace startup
