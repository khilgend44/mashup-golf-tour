const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

// Write a stream URL, returning the prior value if it differed (for overwrite
// detection). The key is only ever built from a validated event + roster name.
async function putStream(accountId, apiToken, eventId, player, round, url) {
  const key = `${eventId}:${player.toLowerCase()}:${round}`;
  const prev = await kvGet(accountId, apiToken, key);
  await kvPut(accountId, apiToken, key, url);
  return (prev && prev !== url) ? prev : null;
}

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

  if (!isRinger && !youtubeUrl) return new Response('Missing YouTube URL', { status: 400 });

  const ytPattern = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)/;
  if (isRinger) {
    if (round1Url && !ytPattern.test(round1Url)) return new Response('Invalid Round 1 YouTube URL', { status: 400 });
    if (round2Url && !ytPattern.test(round2Url)) return new Response('Invalid Round 2 YouTube URL', { status: 400 });
  } else {
    if (players.length > 4) return new Response('Maximum 4 players per stream', { status: 400 });
    if (!ytPattern.test(youtubeUrl)) return new Response('Please enter a valid YouTube URL', { status: 400 });
  }

  const webhookUrl = env.DISCORD_STREAMS_WEBHOOK_URL;
  if (!webhookUrl) return new Response('Webhook not configured', { status: 500 });

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return new Response('Storage not configured', { status: 500 });

  // ── Validate the event and player names before writing anything ──────────
  // Stream keys are `${eventId}:${player}:${round}`. Without this, an anonymous
  // request could seed arbitrary KV keys or target a bogus event. Active events
  // that accept streams live in admin:events; players come from the master
  // roster (plus anyone in this event's draw, to cover subs).
  let event, roster;
  try {
    const [eventsRaw, rosterRaw] = await Promise.all([
      kvGet(accountId, apiToken, 'admin:events'),
      kvGet(accountId, apiToken, 'players:roster'),
    ]);
    const events = eventsRaw ? JSON.parse(eventsRaw) : [];
    event  = events.find(e => e.id === eventId);
    roster = rosterRaw ? JSON.parse(rosterRaw) : [];
  } catch {
    return new Response('Could not verify event', { status: 502 });
  }
  if (!event) return new Response('Unknown event', { status: 404 });
  if (event.status === 'completed') return new Response('This event is completed — stream submissions are closed.', { status: 409 });

  const allowed = new Set([
    ...roster.map(n => String(n).toLowerCase()),
    ...((event.teams || []).flat().map(n => String(n).toLowerCase())),
  ]);
  const unknown = players.find(p => !allowed.has(String(p).toLowerCase()));
  if (unknown) return new Response(`Unknown player: ${unknown}`, { status: 400 });

  // ── Write streams, tracking any that replaced a different existing link ───
  const overwrites = [];
  try {
    if (isRinger) {
      const player = players[0];
      if (round1Url) { const prev = await putStream(accountId, apiToken, eventId, player, 1, round1Url); if (prev) overwrites.push({ player, round: 1, prev, next: round1Url }); }
      if (round2Url) { const prev = await putStream(accountId, apiToken, eventId, player, 2, round2Url); if (prev) overwrites.push({ player, round: 2, prev, next: round2Url }); }

      const lines = [];
      if (round1Url) lines.push(`Round 1: ${round1Url}`);
      if (round2Url) lines.push(`Round 2: ${round2Url}`);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🎥 **${players[0]}** posted stream(s) for **${eventName || eventId}**\n${lines.join('\n')}`, allowed_mentions: { parse: [] } }),
      });
    } else {
      for (const player of players) {
        const prev = await putStream(accountId, apiToken, eventId, player, 1, youtubeUrl);
        if (prev) overwrites.push({ player, round: 1, prev, next: youtubeUrl });
      }
      const playerList = players.join(', ');
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🎥 **${playerList}** ${players.length > 1 ? 'are' : 'is'} live for **${eventName || eventId}**\n${youtubeUrl}`, allowed_mentions: { parse: [] } }),
      });
    }

    // Overwrite alert — a submission replaced a link already on file. With no
    // player login we can't prevent this, so we make it loud/visible instead.
    if (overwrites.length) {
      const lines = overwrites.map(o => `• **${o.player}** (Round ${o.round})\n   was: ${o.prev}\n   now: ${o.next}`);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `⚠️ An existing stream link was **replaced** for **${eventName || eventId}** — verify this was the player themselves:\n${lines.join('\n')}`, allowed_mentions: { parse: [] } }),
      });
    }
  } catch (err) {
    return new Response(`Storage error: ${err.message}`, { status: 502 });
  }

  return Response.json({ ok: true });
}
