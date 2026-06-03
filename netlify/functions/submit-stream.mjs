import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { players, youtubeUrl, eventId, eventName } = body;

  if (!players || !Array.isArray(players) || players.length === 0 || !youtubeUrl || !eventId) {
    return new Response('Missing required fields', { status: 400 });
  }

  if (players.length > 4) {
    return new Response('Maximum 4 players per stream', { status: 400 });
  }

  const ytPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)/;
  if (!ytPattern.test(youtubeUrl)) {
    return new Response('Please enter a valid YouTube URL', { status: 400 });
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return new Response('Webhook not configured', { status: 500 });
  }

  // Save each player's stream link to Netlify Blobs
  const store = getStore('streams');
  for (const player of players) {
    await store.set(`${eventId}:${player.toLowerCase()}`, youtubeUrl);
  }

  // Post to Discord
  const playerList = players.join(', ');
  const discordRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🎥 **${playerList}** ${players.length > 1 ? 'are' : 'is'} live for **${eventName || eventId}**\n${youtubeUrl}`,
    }),
  });

  if (!discordRes.ok) {
    return new Response('Failed to post to Discord', { status: 502 });
  }

  return Response.json({ ok: true });
};

export const config = { path: '/.netlify/functions/submit-stream' };
