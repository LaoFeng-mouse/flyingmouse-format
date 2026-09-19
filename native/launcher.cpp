#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <string>
#include <vector>
#include "startup-access.h"
#include "startup-build.h"

static std::wstring quote(const std::wstring& s) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : s) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    out += c;
  }
  out.append(slashes * 2, L'\\');
  return out + L"\"";
}
static std::string utf8(const std::wstring& text) {
  int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string result(length, 0);
  if (length) WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), length, nullptr, nullptr);
  return result;
}
static void writeText(HANDLE handle, const std::wstring& text) {
  if (!handle || handle == INVALID_HANDLE_VALUE) return;
  const auto data = utf8(text + L"\r\n");
  DWORD written = 0;
  WriteFile(handle, data.data(), static_cast<DWORD>(data.size()), &written, nullptr);
}
static bool validStream(HANDLE source) {
  DWORD flags = 0;
  return source && source != INVALID_HANDLE_VALUE && GetHandleInformation(source, &flags);
}
static HANDLE inherited(DWORD id, HANDLE fallback) {
  HANDLE source = GetStdHandle(id), copy = nullptr;
  if (!validStream(source)) source = fallback;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return nullptr;
  return copy;
}
static int fail(const std::wstring& message, DWORD code, bool quiet) {
  std::wstring text = message + L"\n\n错误代码 / Error: " + std::to_wstring(code);
  writeText(GetStdHandle(STD_ERROR_HANDLE), text);
  if (!quiet) MessageBoxW(nullptr, text.c_str(), FM_TITLE, MB_OK | MB_ICONERROR);
  return code ? static_cast<int>(code) : 1;
}
static DWORD WINAPI drainOutput(void* data) {
  startup::Handle input(static_cast<HANDLE>(data));
  BYTE buffer[8192]; DWORD count = 0;
  while (ReadFile(input.value, buffer, sizeof(buffer), &count, nullptr) && count) {}
  return 0;
}

// Logs must not depend on a particular writable folder or on the NUL device.
// When all destinations fail, a drained pipe still provides valid stdio.
struct StartupLog {
  startup::Handle output;
  startup::Handle drain;
  std::wstring path;
  std::wstring destination = L"discard-pipe";
  DWORD lastError = 0;
  bool openIn(const std::wstring& base, const std::wstring& label) {
    const auto folder = base + L"\\" FM_LOG_FOLDER;
    if (!CreateDirectoryW(folder.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) { lastError = GetLastError(); return false; }
    const auto logs = folder + L"\\Startup";
    if (!CreateDirectoryW(logs.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) { lastError = GetLastError(); return false; }
    const auto candidate = logs + L"\\startup-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L".log";
    output.value = CreateFileW(candidate.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (!output.valid()) { lastError = GetLastError(); return false; }
    path = candidate; destination = label;
    return true;
  }
  StartupLog() {
    PWSTR local = nullptr;
    const HRESULT result = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local);
    bool opened = false;
    if (SUCCEEDED(result)) opened = openIn(local, L"local-app-data");
    if (local) CoTaskMemFree(local);
    if (opened) return;
    wchar_t temp[32768]; const DWORD size = GetTempPathW(32768, temp);
    if (size && size < 32768 && openIn(std::wstring(temp, size), L"temp-fallback")) return;
    HANDLE reader = nullptr;
    if (!CreatePipe(&reader, &output.value, nullptr, 0)) { lastError = GetLastError(); return; }
    drain.value = CreateThread(nullptr, 0, drainOutput, reader, 0, nullptr);
    if (!drain.valid()) { lastError = GetLastError(); CloseHandle(reader); CloseHandle(output.value); output.value = nullptr; }
  }
  ~StartupLog() {
    if (output.valid()) { CloseHandle(output.value); output.value = nullptr; }
    if (drain.valid() && WaitForSingleObject(drain.value, 1000) == WAIT_TIMEOUT) {
      CancelSynchronousIo(drain.value);
      WaitForSingleObject(drain.value, 1000);
    }
  }
};
static std::wstring accessMessage(const startup::CheckResult& result, const std::wstring& directory) {
  std::wstring message;
  if (result.error == ERROR_FILE_NOT_FOUND || result.error == ERROR_PATH_NOT_FOUND)
    message = L"安装文件缺失，请使用完整安装包重新安装。";
  else if (result.error == ERROR_INVALID_DATA || result.error == ERROR_FILE_INVALID)
    message = L"程序资源不完整或与安装包不一致，请重新安装。";
  else if (result.error == ERROR_SHARING_VIOLATION)
    message = L"程序资源被其他程序占用，请稍后重试。";
  else
    message = L"当前安装位置限制了程序资源读取，无法安全地自动修复。请将完整软件安装到当前用户可访问的新目录后重试。";
  return message + L"\n\n文件：" + directory + L"\\" + result.file + L"\n检查阶段：" + result.detail;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0;
  PWSTR* parsed = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!parsed) return fail(L"无法读取启动参数。", GetLastError(), false);
  std::vector<std::wstring> arguments;
  bool cli = false, checkOnly = false, repairOnly = false;
  for (int i = 1; i < argc; ++i) {
    const std::wstring argument = parsed[i];
    if (cli) { arguments.push_back(argument); continue; }
    if (argument == L"--check-startup") checkOnly = true;
    else if (argument == L"--repair-startup") repairOnly = true;
    else { arguments.push_back(argument); if (argument == L"--cli") cli = true; }
  }
  LocalFree(parsed);
  const bool quiet = cli || checkOnly || repairOnly;
  StartupLog log;
  if (!log.output.valid()) return fail(L"无法准备启动输出。", log.lastError, quiet);
  const auto record = [&](const std::wstring& line) {
    writeText(log.output.value, line);
    if (checkOnly || repairOnly) writeText(GetStdHandle(STD_OUTPUT_HANDLE), line);
  };
  record(L"FlyingMouse Format bootstrap " FM_VERSION L" channel=" FM_CHANNEL L" --no-stdio-init");
  record(L"startup-log destination=" + log.destination + L" path=" + log.path);
  wchar_t self[32768];
  const DWORD length = GetModuleFileNameW(nullptr, self, 32768);
  if (!length || length >= 32768) return fail(L"无法定位程序目录。", length ? ERROR_BAD_LENGTH : GetLastError(), quiet);
  std::wstring directory(self, length);
  directory.resize(directory.find_last_of(L"\\/"));
  const std::wstring runtime = directory + L"\\FlyingMouse Format Runtime.exe";
  for (const auto& required : { runtime, directory + L"\\resources\\app.asar" }) {
    if (GetFileAttributesW(required.c_str()) == INVALID_FILE_ATTRIBUTES) {
      DWORD code = GetLastError();
      record(L"startup-file-unavailable file=" + required + L" error=" + std::to_wstring(code));
      return fail(L"无法访问安装文件，请检查安装是否完整及目录读取权限。\n" + required, code, quiet);
    }
  }
  const auto access = startup::checkResources(directory, FM_STARTUP_RESOURCES, !checkOnly, record);
  if (access.error) {
    record(L"startup-check failed file=" + access.file + L" stage=" + access.detail + L" error=" + std::to_wstring(access.error));
    // Failed probe setup is not evidence of unreadable files. Normal startup
    // preserves existing behavior; explicit diagnostic mode reports the error.
    if (access.detail != L"probe-unavailable" || checkOnly || repairOnly)
      return fail(accessMessage(access, directory), access.error, quiet);
  }
  if (checkOnly || repairOnly) return 0;
  std::wstring command = quote(runtime) + L" --no-stdio-init";
  for (const auto& argument : arguments) command += L" " + quote(argument);
  if (command.size() >= 32767) return fail(L"启动参数过长。", ERROR_BAD_LENGTH, quiet);
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", nullptr);
  SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr);
  HANDLE inputReader = nullptr, inputWriter = nullptr;
  if (!CreatePipe(&inputReader, &inputWriter, nullptr, 0)) return fail(L"无法准备启动输入。", GetLastError(), quiet);
  startup::Handle input(inputReader);
  CloseHandle(inputWriter); // EOF without NUL or a writable file.
  STARTUPINFOEXW si = {};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = inherited(STD_INPUT_HANDLE, input.value);
  si.StartupInfo.hStdOutput = inherited(STD_OUTPUT_HANDLE, log.output.value);
  si.StartupInfo.hStdError = inherited(STD_ERROR_HANDLE, log.output.value);
  startup::Handle in(si.StartupInfo.hStdInput), out(si.StartupInfo.hStdOutput), err(si.StartupInfo.hStdError);
  if (!in.valid() || !out.valid() || !err.valid()) return fail(L"无法准备启动输入输出。", GetLastError(), quiet);
  HANDLE handles[] = { in.value, out.value, err.value };
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<BYTE> attributes(bytes);
  si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes)) return fail(L"无法准备启动环境。", GetLastError(), quiet);
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) {
    const DWORD error = GetLastError(); DeleteProcThreadAttributeList(si.lpAttributeList);
    return fail(L"无法设置启动输入输出。", error, quiet);
  }
  PROCESS_INFORMATION pi = {};
  const BOOL ok = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, cli ? nullptr : directory.c_str(), &si.StartupInfo, &pi);
  const DWORD error = GetLastError();
  DeleteProcThreadAttributeList(si.lpAttributeList);
  if (!ok) return fail(L"无法启动飞鼠格式。请检查程序文件及目录访问权限。", error, quiet);
  startup::Handle process(pi.hProcess), thread(pi.hThread);
  WaitForSingleObject(process.value, INFINITE);
  DWORD code = 0;
  if (!GetExitCodeProcess(process.value, &code)) code = GetLastError();
  record(L"Runtime exit code: " + std::to_wstring(code));
  if (code && !cli) {
    const std::wstring detail = log.path.empty() ? L"启动日志无法写入，请检查用户目录和临时目录。"
      : L"请将启动日志发给开发者：\n" + log.path;
    return fail(L"飞鼠格式 " FM_VERSION L" 异常退出。" + detail, code, false);
  }
  return static_cast<int>(code);
}
