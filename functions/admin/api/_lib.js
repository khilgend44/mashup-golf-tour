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

// Admin pages are served on the gated pages.dev host; the custom domains are
// allowed too for completeness. A browser only omits the Origin header on
// same-origin requests, so "Origin present AND not ours" means the request was
// made from another site's page — reject it (CSRF defense-in-depth, independent
// of the Access session cookie's SameSite setting).
const ADMIN_ALLOWED_ORIGINS = ['https://mashupgolf.com', 'https://www.mashupgolf.com'];
const ADMIN_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?mashup-golf-tour\.pages\.dev$/;
function originAllowed(origin) {
  return ADMIN_ALLOWED_ORIGINS.includes(origin) || ADMIN_ORIGIN_RE.test(origin);
}

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

export async function kvDelete(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) throw new Error(`KV delete failed: ${res.status}`);
}

// Lists every key under a prefix (paginated — Cloudflare returns a cursor
// once there are more than ~1000 keys, though this project is nowhere near
// that for registrations).
export async function kvList(accountId, apiToken, prefix) {
  let cursor = '';
  const keys = [];
  do {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!res.ok) break;
    const data = await res.json();
    if (Array.isArray(data.result)) keys.push(...data.result);
    cursor = data.result_info && data.result_info.cursor ? data.result_info.cursor : '';
  } while (cursor);
  return keys;
}

// ─── SGT course name → id resolution ─────────────────────────────────────
// Powers the "scorecard" deep-link on event pages (see /api/course-scorecard).
// SGT's courses/page-data endpoint has no per-course lookup — it returns
// every course (~2500) as a single ~14MB payload — so we cache the parsed
// name→id map in this isolate for a while on top of Cloudflare's own edge
// cache of the raw fetch, since re-parsing on every single event save would
// be wasteful for data that only grows a few courses a month.
let courseIndexCache = { map: null, fetchedAt: 0 };
const COURSE_INDEX_TTL = 6 * 3600_000; // 6h

async function getCourseIndex() {
  if (courseIndexCache.map && Date.now() - courseIndexCache.fetchedAt < COURSE_INDEX_TTL) {
    return courseIndexCache.map;
  }
  const res = await fetch('https://simulatorgolftour.com/sgt-api/courses/page-data', {
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`SGT course list fetch failed: ${res.status}`);
  const data = await res.json();
  const html = data.html || '';

  // Parsed with HTMLRewriter (not regex) — the course cards nest a
  // data-course-id-bearing skeleton loader inside each real card, which
  // makes naive substring/regex scanning mispair ids with the wrong name.
  const map = new Map();
  let currentId = null;
  let capturingName = false;
  let nameBuffer = '';

  const rewriter = new HTMLRewriter()
    .on('div.course-card[data-course-id]', {
      element(el) { currentId = el.getAttribute('data-course-id'); },
    })
    .on('div.course-card [data-sort-key="NAME"]', {
      element() { capturingName = true; nameBuffer = ''; },
      text(chunk) {
        if (!capturingName) return;
        nameBuffer += chunk.text;
        if (chunk.lastInTextNode) {
          const name = nameBuffer.trim();
          if (name && currentId) map.set(name.toLowerCase(), currentId);
          capturingName = false;
        }
      },
    });

  await rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html' } })).text();

  courseIndexCache = { map, fetchedAt: Date.now() };
  return map;
}

// Best-effort: attach courseId to any round with a course name but no id yet.
// Never throws — a lookup miss/failure just leaves that round's id unset,
// it must never block an event save.
export async function resolveCourseIds(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return rounds;
  if (!rounds.some(r => r?.course && !r.courseId)) return rounds;
  try {
    const index = await getCourseIndex();
    return rounds.map(r => {
      if (!r?.course || r.courseId) return r;
      const id = index.get(String(r.course).trim().toLowerCase());
      return id ? { ...r, courseId: Number(id) } : r;
    });
  } catch {
    return rounds;
  }
}

// Returns null if authorized, or a 403 Response if not.
export async function requireAccess(request, env) {
  // Reject cross-origin browser requests outright (CSRF). No Origin header ⇒
  // same-origin or non-browser caller, which still has to pass the checks below.
  const origin = request.headers.get('Origin');
  if (origin && !originAllowed(origin)) {
    return Response.json({ error: 'Forbidden — cross-origin request' }, { status: 403, headers: CORS });
  }
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
