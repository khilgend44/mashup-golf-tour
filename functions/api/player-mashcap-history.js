// Public read of the long-term per-event MashCAP trend — one point per
// activated event, independent of players:rounds' ~48-round rolling window
// (SGT trims that on every refresh, so it can never show more than a few
// months of history no matter how long a player's career runs). Written by
// functions/admin/api/events.js's activate-event action and the one-time
// backfill-mashcap-history migration. See ARCHITECTURE.md.
//   GET /api/player-mashcap-history            → { history: { player: [...] } }
//   GET /api/player-mashcap-history?player=x   → { player: "x", history: [...] }
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
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  try {
    const raw = await kvGet(accountId, apiToken, 'players:mashcap-history');
    const all = raw ? JSON.parse(raw) : {};
    const player = new URL(request.url).searchParams.get('player');
    if (player) {
      const history = all[player.toLowerCase()] || [];
      return Response.json({ player, history }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }
    return Response.json({ history: all }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
