export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId');

  if (!eventId) {
    return new Response('Missing eventId', { status: 400 });
  }

  const list = await env.STREAMS.list({ prefix: `${eventId}:` });

  const result = {};
  for (const key of list.keys) {
    const rest = key.name.replace(`${eventId}:`, '');
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) continue;
    const player = rest.slice(0, lastColon);
    const round  = rest.slice(lastColon + 1);
    if (!result[player]) result[player] = {};
    result[player][round] = await env.STREAMS.get(key.name);
  }

  return Response.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
