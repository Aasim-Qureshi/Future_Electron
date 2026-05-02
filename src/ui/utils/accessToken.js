/**
 * Decode JWT payload (base64url) in the renderer without verifying signature.
 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad === 1) return null;
    if (pad) b64 += "=".repeat(4 - pad);
    const json = JSON.parse(atob(b64));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/**
 * Whether the JWT access token is still valid (default: 2 min skew before exp).
 */
export function isAccessTokenValid(token, skewMs = 120000) {
  const json = decodeJwtPayload(token);
  if (!json) return false;
  if (json.exp == null) return true;
  return json.exp * 1000 > Date.now() + skewMs;
}

export { decodeJwtPayload };
