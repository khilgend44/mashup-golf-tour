// Public YouTube video duration lookup. Route: GET /api/youtube-duration?url=<youtube-url>
// (or ?videoId=<id> directly). Building block for the Event Summary "Pace of
// Play" stats (total time played / fastest / slowest round).
//
// Deliberately public, not admin-protected: a video's length isn't sensitive
// data (the stream URLs themselves are already visible on the public event
// page), and event-summary.html — a public page — needs to call this
// directly from the browser, once per unique video, rather than the server
// fanning out to N videos in one invocation. That per-invocation fan-out is
// exactly what event-pace.js (removed) got wrong: Cloudflare's subrequest
// limit killed it once a week's stream count got past ~15-20 videos (S10W1
// alone has 41). One video per call here keeps each invocation to at most
// 3 subrequests (cache check, YouTube fetch, cache write) regardless of how
// many videos a page ultimately needs — the fan-out happens in the browser,
// which has no such limit.
//
// Durations are cached forever in KV (`yt-duration:<videoId>`) since a
// published video's length never changes, so repeat views of the same event
// (or another event reusing the same stream) cost zero YouTube API quota.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) return Response.json({ error: 'YOUTUBE_API_KEY not configured' }, { status: 500, headers: CORS });

  const params = new URL(request.url).searchParams;
  const videoId = params.get('videoId') || extractVideoId(params.get('url'));
  if (!videoId) return Response.json({ error: 'Provide a valid ?url= (YouTube link) or ?videoId=' }, { status: 400, headers: CORS });

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  const cacheKey  = `yt-duration:${videoId}`;

  try {
    if (accountId && apiToken) {
      const cached = await kvGet(accountId, apiToken, cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return Response.json({ videoId, ...parsed, cached: true }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=86400' } });
      }
    }

    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(videoId)}&key=${apiKey}`);
    const data = await res.json();
    if (!res.ok) return Response.json({ error: `YouTube API returned ${res.status}: ${data.error?.message || 'Unknown error'}` }, { status: 502, headers: CORS });

    const item = data.items?.[0];
    if (!item) return Response.json({ error: `No video found for id ${videoId}` }, { status: 404, headers: CORS });

    const durationSeconds = parseIsoDuration(item.contentDetails.duration);
    const payload = { durationSeconds };
    if (accountId && apiToken && durationSeconds != null) {
      await kvPut(accountId, apiToken, cacheKey, JSON.stringify(payload));
    }
    return Response.json({ videoId, ...payload, cached: false }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
