import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId');

  if (!eventId) {
    return new Response('Missing eventId', { status: 400 });
  }

  const store = getStore({ name: 'streams', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: `${eventId}:` });

  // Group by player: { playerName: { "1": url, "2": url } }
  const result = {};
  for (const blob of blobs) {
    const rest = blob.key.replace(`${eventId}:`, '');
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) continue; // skip old-format keys
    const player = rest.slice(0, lastColon);
    const round  = rest.slice(lastColon + 1);
    if (!result[player]) result[player] = {};
    result[player][round] = await store.get(blob.key);
  }

  return Response.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/.netlify/functions/get-streams' };
