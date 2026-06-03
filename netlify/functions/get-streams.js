const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const eventId = event.queryStringParameters?.eventId;
  if (!eventId) {
    return { statusCode: 400, body: 'Missing eventId' };
  }

  const store = getStore('streams');
  const { blobs } = await store.list({ prefix: `${eventId}:` });

  const result = {};
  for (const blob of blobs) {
    const player = blob.key.replace(`${eventId}:`, '');
    result[player] = await store.get(blob.key);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(result),
  };
};
