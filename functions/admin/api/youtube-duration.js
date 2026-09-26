// Admin-only YouTube video duration lookup. Route: GET /admin/api/youtube-duration?url=<youtube-url>
// (or ?videoId=<id> directly). Building block for the Event Summary "total
// time played" / "fastest round" stats — reads one video's length via the
// YouTube Data API v3. Costs 1 quota unit per call against the free 10k/day
// quota, so this is safe to call once per unique stream URL per event.
import { CORS, requireAccess } from './_lib.js';

// Same URL shapes already accepted by /api/submit-stream.js.
const YT_URL_PATTERN = /^https?:\/\/(www\.)?(?:youtube\.com\/watch\?v=([\w-]+)|youtu\.be\/([\w-]+)|youtube\.com\/live\/([\w-]+))/;

function extractVideoId(url) {
  const m = String(url || '').match(YT_URL_PATTERN);
  if (!m) return null;
  return m[2] || m[3] || m[4] || null;
}

// ISO 8601 duration ("PT1H2M10S", "PT4M13S", "PT45S") -> total seconds.
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
  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) return Response.json({ error: 'YOUTUBE_API_KEY not configured in environment' }, { status: 500, headers: CORS });

  const params = new URL(request.url).searchParams;
  const videoId = params.get('videoId') || extractVideoId(params.get('url'));
  if (!videoId) return Response.json({ error: 'Provide a valid ?url= (YouTube link) or ?videoId=' }, { status: 400, headers: CORS });

  try {
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${encodeURIComponent(videoId)}&key=${apiKey}`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (!res.ok) {
      return Response.json({ error: `YouTube API returned ${res.status}: ${data.error?.message || 'Unknown error'}` }, { status: 502, headers: CORS });
    }
    const item = data.items?.[0];
    if (!item) return Response.json({ error: `No video found for id ${videoId} — it may be private, deleted, or the ID is wrong.` }, { status: 404, headers: CORS });

    const durationSeconds = parseIsoDuration(item.contentDetails.duration);
    return Response.json({
      videoId,
      title: item.snippet?.title || null,
      durationIso: item.contentDetails.duration,
      durationSeconds,
      durationFormatted: durationSeconds != null
        ? `${Math.floor(durationSeconds / 3600) > 0 ? Math.floor(durationSeconds / 3600) + 'h ' : ''}${Math.floor((durationSeconds % 3600) / 60)}m ${durationSeconds % 60}s`
        : null,
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
