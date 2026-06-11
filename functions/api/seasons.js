const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

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
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken)
    return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  try {
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    return Response.json(raw ? JSON.parse(raw) : [], {
      headers: { ...CORS, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken)
    return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const { action } = body;

  if (action === 'create-season') {
    const { season } = body;
    if (!season || !season.id)
      return Response.json({ error: 'Missing season data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    if (seasons.find(s => s.id === season.id))
      return Response.json({ error: `Season ${season.id} already exists` }, { status: 409, headers: CORS });
    seasons.push(season);
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season }, { headers: CORS });
  }

  if (action === 'update-season') {
    const { season } = body;
    if (!season || !season.id)
      return Response.json({ error: 'Missing season data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    const idx = seasons.findIndex(s => s.id === season.id);
    if (idx === -1)
      return Response.json({ error: 'Season not found' }, { status: 404, headers: CORS });
    seasons[idx] = season;
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season }, { headers: CORS });
  }

  if (action === 'archive-season') {
    const { seasonId } = body;
    if (!seasonId)
      return Response.json({ error: 'Missing seasonId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    const idx = seasons.findIndex(s => s.id === seasonId);
    if (idx === -1)
      return Response.json({ error: 'Season not found' }, { status: 404, headers: CORS });
    seasons[idx] = { ...seasons[idx], status: 'completed' };
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season: seasons[idx] }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
