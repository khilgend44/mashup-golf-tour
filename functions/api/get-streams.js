const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

// Both throw an Error carrying the real Cloudflare API response body (not
// just the HTTP status) — a blanket catch used to swallow this down to a
// bare `{}`, which made a genuine failure (bad token scope, KV outage,
// wrong account id, ...) indistinguishable from "no streams submitted yet".
// Confirmed 2026-09: streams silently stopped showing for a live event even
// though the underlying KV data was intact, and there was no way to tell
// from the outside what actually failed.
async function kvList(accountId, apiToken, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`KV list failed: ${res.status} ${body}`);
  const data = JSON.parse(body);
  return data.result ?? [];
}

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
  if (!res.ok) throw new Error(`KV get failed for ${key}: ${res.status} ${await res.text()}`);
  return res.text();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return new Response('Missing eventId', { status: 400 });
  const debug = url.searchParams.get('debug') === '1';

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return debug
      ? Response.json({ error: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in environment' }, { status: 500 })
      : Response.json({});
  }

  try {
    const keys = await kvList(accountId, apiToken, `${eventId}:`);
    const result = {};
    for (const keyObj of keys) {
      const rest = keyObj.name.replace(`${eventId}:`, '');
      const lastColon = rest.lastIndexOf(':');
      if (lastColon === -1) continue;
      const player = rest.slice(0, lastColon);
      const round  = rest.slice(lastColon + 1);
      if (!result[player]) result[player] = {};
      result[player][round] = await kvGet(accountId, apiToken, keyObj.name);
    }
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // Public default stays a quiet {} — a normal visitor shouldn't see a
    // scary error just because stream icons couldn't load. ?debug=1 (used
    // manually while investigating, never linked from the site) returns the
    // real failure instead of guessing from the outside.
    return debug
      ? Response.json({ error: e.message }, { status: 500 })
      : Response.json({});
  }
}
