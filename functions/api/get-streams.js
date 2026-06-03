const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

async function kvList(accountId, apiToken, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
  if (!res.ok) throw new Error(`KV list failed: ${res.status}`);
  const data = await res.json();
  return data.result ?? [];
}

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return new Response('Missing eventId', { status: 400 });

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({});

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
  } catch {
    return Response.json({});
  }
}
