export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { players, youtubeUrl, round1Url, round2Url, eventId, eventName } = body;

  if (!players || !Array.isArray(players) || players.length === 0 || !eventId) {
    return new Response('Missing required fields', { status: 400 });
  }

  const isRinger = !!(round1Url || round2Url);

  if (!isRinger && !youtubeUrl) {
    return new Response('Missing YouTube URL', { status: 400 });
  }

  const ytPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)/;

  if (isRinger) {
    if (round1Url && !ytPattern.test(round1Url)) return new Response('Invalid Round 1 YouTube URL', { status: 400 });
    if (round2Url && !ytPattern.test(round2Url)) return new Response('Invalid Round 2 YouTube URL', { status: 400 });
  } else {
    if (players.length > 4) return new Response('Maximum 4 players per stream', { status: 400 });
    if (!ytPattern.test(youtubeUrl)) return new Response('Please enter a valid YouTube URL', { status: 400 });
  }

  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return new Response('Webhook not configured', { status: 500 });

  if (isRinger) {
    const player = players[0].toLowerCase();
    if (round1Url) await env.STREAMS.put(`${eventId}:${player}:1`, round1Url);
    if (round2Url) await env.STREAMS.put(`${eventId}:${player}:2`, round2Url);

    const lines = [];
    if (round1Url) lines.push(`Round 1: ${round1Url}`);
    if (round2Url) lines.push(`Round 2: ${round2Url}`);
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🎥 **${players[0]}** posted stream(s) for **${eventName || eventId}**\n${lines.join('\n')}`,
      }),
    });
  } else {
    for (const player of players) {
      await env.STREAMS.put(`${eventId}:${player.toLowerCase()}:1`, youtubeUrl);
    }
    const playerList = players.join(', ');
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🎥 **${playerList}** ${players.length > 1 ? 'are' : 'is'} live for **${eventName || eventId}**\n${youtubeUrl}`,
      }),
    });
  }

  return Response.json({ ok: true });
}
