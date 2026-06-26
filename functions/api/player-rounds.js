// Public read of stored per-round handicap data (date/differential/tour),
// used by the "See Counting Events" detail page.
//   GET /api/player-rounds            → { rounds: { player: [...] } }
//   GET /api/player-rounds?player=x   → { player: "x", rounds: [...] }
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
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  try {
    const raw = await kvGet(accountId, apiToken, 'players:rounds');
    const all = raw ? JSON.parse(raw) : {};
    const player = new URL(request.url).searchParams.get('player');
    if (player) {
      const rounds = all[player.toLowerCase()] || [];
      return Response.json({ player, rounds }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }
    return Response.json({ rounds: all }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
