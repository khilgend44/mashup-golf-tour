// Public proxy for SGT course scorecard images. SGT's CDN enforces referer-based
// hotlink protection (only simulatorgolftour.com is allowed), so a plain
// <img>/<a> straight to their asset 403s for our visitors. This fetches the
// image server-side with the right referer and streams it back under our own
// domain.
//   GET /api/course-scorecard?id=3142
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request } = context;
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return Response.json({ error: 'Missing or invalid course id' }, { status: 400, headers: CORS });
  }

  const imageUrl = `https://sgt-static.b-cdn.net/public/assets/courseImages/scorecards/scorecard_${id}.jpg`;
  let res;
  try {
    res = await fetch(imageUrl, {
      headers: { Referer: 'https://simulatorgolftour.com/courses' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch (e) {
    return Response.json({ error: `Could not reach SGT: ${e.message}` }, { status: 502, headers: CORS });
  }
  if (!res.ok) {
    return Response.json({ error: `SGT returned ${res.status} for course ${id}` }, { status: 502, headers: CORS });
  }

  return new Response(res.body, {
    headers: {
      ...CORS,
      'Content-Type': res.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
