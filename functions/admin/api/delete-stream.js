// Protected admin endpoint to remove a stream link that was submitted in
// error (e.g. posted before the round was actually played, or for the wrong
// event). Route: POST /admin/api/delete-stream  { eventId, players }
//
// Deletes every stream key for each given player under that event (covers
// both the single-round case and the ringer round1/round2 case), so the
// player can resubmit a correct link via the normal /api/submit-stream flow
// without submit-stream.js treating it as an "overwrite" of a stale link.
import { CORS, kvList, kvDelete, requireAccess } from './_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const { eventId, players } = body;
  if (!eventId) return Response.json({ error: 'eventId required' }, { status: 400, headers: CORS });
  if (!Array.isArray(players) || !players.length) return Response.json({ error: 'players required' }, { status: 400, headers: CORS });

  const deleted = [];
  for (const player of players) {
    const prefix = `${eventId}:${String(player).toLowerCase()}:`;
    const keys = await kvList(accountId, apiToken, prefix);
    for (const k of keys) {
      await kvDelete(accountId, apiToken, k.name);
      deleted.push(k.name);
    }
  }

  return Response.json({ ok: true, deleted }, { headers: CORS });
}
