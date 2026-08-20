function parseUrl(value, base) {
  try {
    return base ? new URL(String(value), base) : new URL(String(value));
  } catch {
    return null;
  }
}

function isTrustedRendererUrl(candidate, serverUrl) {
  const trusted = parseUrl(serverUrl);
  const parsed = parseUrl(candidate);
  if (!trusted || !parsed) return false;
  return trusted.protocol === "http:"
    && trusted.hostname === "127.0.0.1"
    && parsed.origin === trusted.origin
    && !parsed.username
    && !parsed.password;
}

function resolveTrustedDownloadUrl(candidate, serverUrl) {
  const parsed = parseUrl(candidate, serverUrl);
  if (!parsed || !isTrustedRendererUrl(parsed.toString(), serverUrl)) return null;
  if (!/^\/downloads\/[^/]+$/.test(parsed.pathname)
      && !/^\/downloads\/[^/]+\/asset\/[^/]+$/.test(parsed.pathname)) return null;
  if (parsed.search || parsed.hash) return null;
  return parsed.toString();
}

function isAllowedExternalUrl(candidate) {
  const parsed = parseUrl(candidate);
  return Boolean(parsed
    && parsed.protocol === "https:"
    && parsed.hostname
    && !parsed.username
    && !parsed.password);
}

module.exports = {
  isTrustedRendererUrl,
  resolveTrustedDownloadUrl,
  isAllowedExternalUrl
};
