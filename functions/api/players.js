const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const SGT_API_BASE = 'https://simulatorgolftour.com/sgt-api/mashup/player-check';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  try {
    const [rosterRaw, handicapsRaw, lastRefreshRaw] = await Promise.all([
      kvGet(accountId, apiToken, 'players:roster'),
      kvGet(accountId, apiToken, 'players:handicaps'),
      kvGet(accountId, apiToken, 'players:last_refresh'),
    ]);
    return Response.json({
      roster: rosterRaw ? JSON.parse(rosterRaw) : [],
      handicaps: handicapsRaw ? JSON.parse(handicapsRaw) : {},
      lastRefresh: lastRefreshRaw || null,
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

// Write actions (onboard/add/remove/refresh) moved to the Access-protected
// endpoint: functions/admin/api/players.js  (/admin/api/players)
