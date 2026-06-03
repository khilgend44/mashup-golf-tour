const { getStore } = require('@netlify/blobs');

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

  const { players, youtubeUrl, eventId, eventName } = body;

  if (!players || !Array.isArray(players) || players.length === 0 || !youtubeUrl || !eventId) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  if (players.length > 4) {
    return { statusCode: 400, body: 'Maximum 4 players per stream' };
  }

  const ytPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)/;
  if (!ytPattern.test(youtubeUrl)) {
    return { statusCode: 400, body: 'Please enter a valid YouTube URL' };
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return { statusCode: 500, body: 'Webhook not configured' };
  }

  // Save each player's stream link to Netlify Blobs
  const store = getStore('streams');
  for (const player of players) {
    await store.set(`${eventId}:${player.toLowerCase()}`, youtubeUrl);
  }

  // Post to Discord
  const playerList = players.join(', ');
  const discordMessage = {
    content: `🎥 **${playerList}** ${players.length > 1 ? 'are' : 'is'} live for **${eventName || eventId}**\n${youtubeUrl}`,
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
