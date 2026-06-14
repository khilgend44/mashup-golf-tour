// Shared helpers for admin WRITE endpoints (/admin/api/*).
//
// These endpoints live under /admin/, which is protected by a Cloudflare Access
// application. Cloudflare blocks unauthenticated requests before they ever reach
// this code. The requireAccess() guard below is defense-in-depth: writes fail
// closed even if the Access path is ever misconfigured.
//
// Two levels of protection:
//   1. Always: requires the Cf-Access-Jwt-Assertion header (only present after a
//      request passes through the Access gate).
//   2. Optional hardening: if CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD env vars are
//      set, the token is cryptographically verified (signature + audience + expiry).

const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

export async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

// Returns null if authorized, or a 403 Response if not.
export async function requireAccess(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return Response.json({ error: 'Unauthorized — admin access required' }, { status: 403, headers: CORS });
  }
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN; // e.g. https://yourteam.cloudflareaccess.com
  const aud        = env.CF_ACCESS_AUD;          // Application Audience (AUD) tag
  if (teamDomain && aud) {
    const ok = await verifyAccessJwt(jwt, teamDomain.replace(/\/$/, ''), aud);
    if (!ok) {
      return Response.json({ error: 'Unauthorized — invalid access token' }, { status: 403, headers: CORS });
    }
  }
  return null;
}

// ─── Cloudflare Access JWT verification (RS256) ──────────────────────────────
let certCache = { keys: null, fetchedAt: 0 };

async function verifyAccessJwt(token, teamDomain, aud) {
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return false;

    const header  = JSON.parse(b64urlToString(headerB64));
    const payload = JSON.parse(b64urlToString(payloadB64));

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return false;
    if (payload.iss && payload.iss !== teamDomain) return false;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return false;

    const jwk = await getSigningKey(teamDomain, header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sigB64), data);
  } catch {
    return false;
  }
}

async function getSigningKey(teamDomain, kid) {
  if (!certCache.keys || Date.now() - certCache.fetchedAt > 3600_000) {
    const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const data = await res.json();
    certCache = { keys: data.keys || [], fetchedAt: Date.now() };
  }
  return certCache.keys.find(k => k.kid === kid) || null;
}

function b64urlToString(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}
function b64urlToBytes(s) {
  const bin = b64urlToString(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
