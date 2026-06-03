import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId');

  if (!eventId) {
    return new Response('Missing eventId', { status: 400 });
  }

  const store = getStore('streams');
  const { blobs } = await store.list({ prefix: `${eventId}:` });

  const result = {};
  for (const blob of blobs) {
    const player = blob.key.replace(`${eventId}:`, '');
    result[player] = await store.get(blob.key);
  }

  return Response.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/.netlify/functions/get-streams' };
