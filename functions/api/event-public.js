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

  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  if (!id) return Response.json({ error: 'Missing id parameter' }, { status: 400, headers: CORS });

  try {
    const [eventsRaw, formatsRaw, handicapsRaw, rosterRaw] = await Promise.all([
      kvGet(accountId, apiToken, 'admin:events'),
      kvGet(accountId, apiToken, 'admin:formats'),
      kvGet(accountId, apiToken, 'players:handicaps'),
      kvGet(accountId, apiToken, 'players:roster'),
    ]);

    const events = eventsRaw ? JSON.parse(eventsRaw) : [];
    const event = events.find(e => e.id === id);
    if (!event) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });

    return Response.json({
      event,
      formats:   formatsRaw   ? JSON.parse(formatsRaw)   : {},
      handicaps: handicapsRaw ? JSON.parse(handicapsRaw) : [],
      roster:    rosterRaw    ? JSON.parse(rosterRaw)    : [],
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
