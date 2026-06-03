exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { player, youtubeUrl, eventId, eventName } = body;

  if (!player || !youtubeUrl || !eventId) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  // Basic YouTube URL validation
  const ytPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)/;
  if (!ytPattern.test(youtubeUrl)) {
    return { statusCode: 400, body: 'Invalid YouTube URL' };
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return { statusCode: 500, body: 'Webhook not configured' };
  }

  // Post to Discord
  const discordMessage = {
    content: `🎥 **${player}** is live for **${eventName || eventId}**\n${youtubeUrl}`,
  };

  const discordRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(discordMessage),
  });

  if (!discordRes.ok) {
    return { statusCode: 502, body: 'Failed to post to Discord' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
