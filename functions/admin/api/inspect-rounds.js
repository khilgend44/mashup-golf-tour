// TEMPORARY debug endpoint to inspect the SGT player-hcp-rounds API shape.
// Route: /admin/api/inspect-rounds?players=boiler_kh
// Protected by Cloudflare Access. Safe to delete once we've reviewed the data.
import { CORS, requireAccess } from './_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const key = env.player_api_key;
  if (!key) return Response.json({ error: 'player_api_key not configured' }, { status: 500, headers: CORS });

  const url = new URL(request.url);
  const players = url.searchParams.get('players') || 'boiler_kh';
  const sgtUrl = `https://simulatorgolftour.com/sgt-api/mashup/player-hcp-rounds?key=${key}&players=${encodeURIComponent(players)}`;

  const res  = await fetch(sgtUrl);
  const text = await res.text();

  // Pretty-print if it's JSON, otherwise pass through raw so we can see exactly
  // what the endpoint returns (including non-JSON error bodies).
  let body = text;
  try { body = JSON.stringify(JSON.parse(text), null, 2); } catch {}

  return new Response(body, {
    status: res.status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
