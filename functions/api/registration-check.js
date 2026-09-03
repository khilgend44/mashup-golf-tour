// Public returning-player check. Route: GET /api/registration-check?username=x&season=season-10
// Returns ONLY booleans — never any stored personal data — so a returning
// player can be recognized without leaking anyone's info by username.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}
async function kvListKeys(accountId, apiToken, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  const url = new URL(request.url);
  const username = String(url.searchParams.get('username') || '').trim();
  const season   = String(url.searchParams.get('season') || 'season-10');
  if (!username) return Response.json({ error: 'username required' }, { status: 400, headers: CORS });
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500, headers: CORS });

  const lc = username.toLowerCase();
  const [metaRaw, rosterRaw, seasonsRes, existingKeys, legacyRaw] = await Promise.all([
    kvGet(accountId, apiToken, 'players:meta'),
    kvGet(accountId, apiToken, 'players:roster'),
    fetch(new URL('/api/seasons', request.url)).catch(() => null),
    kvListKeys(accountId, apiToken, `registrations:${season}:${lc}:`),
    // Legacy shared-list key — read-only fallback in case this request lands
    // before admin/api/registrations.js's GET has done its one-time
    // migration off the old shared-list design for this season.
    kvGet(accountId, apiToken, `registrations:${season}`),
  ]);
  const meta    = metaRaw ? JSON.parse(metaRaw) : {};
  const roster  = rosterRaw ? JSON.parse(rosterRaw) : [];
  const seasons = seasonsRes && seasonsRes.ok ? await seasonsRes.json() : [];

  // Returning = we have metadata on file, or they're on the current roster.
  const returning = !!meta[lc] || roster.some(n => n.toLowerCase() === lc);

  // Already registered = an active (non-declined) registration record exists,
  // OR they're already on this season's roster. The roster check matters on
  // its own — a registration record can be deleted (e.g. admin cleanup) while
  // the player stays rostered, and they still shouldn't be able to re-register.
  const thisSeason = seasons.find(s => s.id === season);
  const onSeasonRoster = !!thisSeason && (thisSeason.players || []).some(n => String(n).toLowerCase() === lc);

  let alreadyRegistered = onSeasonRoster;
  if (!alreadyRegistered && existingKeys.length) {
    const existingRecs = await Promise.all(existingKeys.map(k => kvGet(accountId, apiToken, k.name)));
    alreadyRegistered = existingRecs.some(v => {
      try { return v && JSON.parse(v).status !== 'declined'; } catch { return false; }
    });
  }
  if (!alreadyRegistered && legacyRaw) {
    try {
      const legacyList = JSON.parse(legacyRaw);
      alreadyRegistered = Array.isArray(legacyList) && legacyList.some(r => r.username.toLowerCase() === lc && r.status !== 'declined');
    } catch { /* ignore malformed legacy data */ }
  }

  return Response.json({ returning, alreadyRegistered }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
