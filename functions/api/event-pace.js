// Public "pace of play" stats for an event. Route: GET /api/event-pace?eventId=<event.id>
// Reads every stream URL submitted for the event (same KV keys get-streams.js
// reads: `${eventId}:${player}:${round}`), resolves each unique video's
// length via the YouTube Data API, and attributes time per (player, round).
//
// Attribution rule: a video's duration is divided by however many
// (player, round) slots point to it. This one rule covers both real cases —
// a Solo Ringer player who recorded both rounds in one continuous video
// (2 slots, same player, different rounds -> each round gets half), and a
// team event where 3 players share one shared-camera stream for their one
// round (3 slots, same round, different players -> each player's estimated
// time is a third). Summing the attributed shares for a video always adds
// back up to exactly that video's own length, so "total time played" is
// simply the sum of each *unique* video's duration -- no double-counting.
//
// Video durations are cached forever in KV (`yt-duration:<videoId>`) since a
// published video's length never changes -- this keeps YouTube API calls to
// roughly "once ever per unique stream video", not once per page view.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function kvList(accountId, apiToken, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.result ?? [];
}
async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}
async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: value,
  });
}

// Same URL shapes accepted by /api/submit-stream.js.
const YT_URL_PATTERN = /^https?:\/\/(www\.)?(?:youtube\.com\/watch\?v=([\w-]+)|youtu\.be\/([\w-]+)|youtube\.com\/live\/([\w-]+))/;
function extractVideoId(url) {
  const m = String(url || '').match(YT_URL_PATTERN);
  return m ? (m[2] || m[3] || m[4] || null) : null;
}
function parseIsoDuration(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, h, min, s] = m;
  return (parseInt(h) || 0) * 3600 + (parseInt(min) || 0) * 60 + (parseInt(s) || 0);
}

async function getDuration(accountId, apiToken, apiKey, videoId) {
  const cacheKey = `yt-duration:${videoId}`;
  const cached = await kvGet(accountId, apiToken, cacheKey);
  if (cached) {
    try { return JSON.parse(cached).durationSeconds; } catch { /* fall through to refetch */ }
  }
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${apiKey}`);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  const durationSeconds = parseIsoDuration(item.contentDetails.duration);
  if (durationSeconds != null) {
    await kvPut(accountId, apiToken, cacheKey, JSON.stringify({ durationSeconds, cachedAt: new Date().toISOString() }));
  }
  return durationSeconds;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const eventId = new URL(request.url).searchParams.get('eventId');
  if (!eventId) return Response.json({ error: 'eventId required' }, { status: 400, headers: CORS });

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  const apiKey    = env.YOUTUBE_API_KEY;
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500, headers: CORS });
  if (!apiKey) return Response.json({ error: 'YOUTUBE_API_KEY not configured' }, { status: 500, headers: CORS });

  try {
    // 1. Every stream submitted for this event.
    const keys = await kvList(accountId, apiToken, `${eventId}:`);
    const entries = [];
    for (const keyObj of keys) {
      const rest = keyObj.name.replace(`${eventId}:`, '');
      const lastColon = rest.lastIndexOf(':');
      if (lastColon === -1) continue;
      const player = rest.slice(0, lastColon);
      const round = rest.slice(lastColon + 1);
      const url = await kvGet(accountId, apiToken, keyObj.name);
      const videoId = extractVideoId(url);
      if (videoId) entries.push({ player, round, videoId });
    }

    if (!entries.length) {
      return Response.json({ totalSeconds: 0, fastestRound: null, slowestRound: null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    // 2. Resolve each unique video's duration (cached after the first time).
    const uniqueIds = [...new Set(entries.map(e => e.videoId))];
    const durationById = {};
    for (const id of uniqueIds) durationById[id] = await getDuration(accountId, apiToken, apiKey, id);

    // 3. Group by video to know how many (player, round) slots share it.
    const slotsByVideo = {};
    for (const e of entries) {
      if (!slotsByVideo[e.videoId]) slotsByVideo[e.videoId] = [];
      slotsByVideo[e.videoId].push(e);
    }

    // 4. Attribute each video's duration evenly across the slots sharing it.
    const attributed = [];
    for (const [videoId, slots] of Object.entries(slotsByVideo)) {
      const duration = durationById[videoId];
      if (duration == null) continue;
      const perSlot = duration / slots.length;
      for (const slot of slots) attributed.push({ player: slot.player, round: slot.round, seconds: perSlot });
    }

    const totalSeconds = uniqueIds.reduce((sum, id) => sum + (durationById[id] || 0), 0);
    const fastestRound = attributed.length ? attributed.reduce((a, b) => b.seconds < a.seconds ? b : a) : null;
    const slowestRound = attributed.length ? attributed.reduce((a, b) => b.seconds > a.seconds ? b : a) : null;

    return Response.json({ totalSeconds, fastestRound, slowestRound }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
