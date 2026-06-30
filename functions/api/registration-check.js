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
  const [metaRaw, regRaw, rosterRaw] = await Promise.all([
    kvGet(accountId, apiToken, 'players:meta'),
    kvGet(accountId, apiToken, `registrations:${season}`),
    kvGet(accountId, apiToken, 'players:roster'),
  ]);
  const meta   = metaRaw ? JSON.parse(metaRaw) : {};
  const reg    = regRaw ? JSON.parse(regRaw) : [];
  const roster = rosterRaw ? JSON.parse(rosterRaw) : [];

  // Returning = we have metadata on file, or they're on the current roster.
  const returning = !!meta[lc] || roster.some(n => n.toLowerCase() === lc);
  const alreadyRegistered = reg.some(r => r.username.toLowerCase() === lc && r.status !== 'declined');

  return Response.json({ returning, alreadyRegistered }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
