// Public read for the season schedule — lightweight "what's coming" entries
// (week + format name + rough dates) for weeks that don't have a real event
// yet. Route: GET /api/schedule
//
// Separate from admin:events on purpose: a real event requires an SGT
// tournament URL (admin/events.html won't let you create one without it),
// but the league wants to see planned formats for future weeks well before
// a course gets picked and an SGT event gets created. Writes are protected,
// under /admin/api/schedule.
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
    const raw = await kvGet(accountId, apiToken, 'admin:schedule');
    let entries = raw ? JSON.parse(raw) : [];
    const season = new URL(request.url).searchParams.get('season');
    if (season) entries = entries.filter(e => e.season === season);
    return Response.json(entries, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
