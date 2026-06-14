// Protected admin WRITE endpoint for seasons.  Route: /admin/api/seasons
// Reads remain public at /api/seasons.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

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

  const { action } = body;

  if (action === 'create-season') {
    const { season } = body;
    if (!season || !season.id) return Response.json({ error: 'Missing season data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    if (seasons.find(s => s.id === season.id))
      return Response.json({ error: `Season ${season.id} already exists` }, { status: 409, headers: CORS });
    seasons.push(season);
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season }, { headers: CORS });
  }

  if (action === 'update-season') {
    const { season } = body;
    if (!season || !season.id) return Response.json({ error: 'Missing season data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    const idx = seasons.findIndex(s => s.id === season.id);
    if (idx === -1) return Response.json({ error: 'Season not found' }, { status: 404, headers: CORS });
    seasons[idx] = season;
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season }, { headers: CORS });
  }

  if (action === 'archive-season') {
    const { seasonId } = body;
    if (!seasonId) return Response.json({ error: 'Missing seasonId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:seasons');
    const seasons = raw ? JSON.parse(raw) : [];
    const idx = seasons.findIndex(s => s.id === seasonId);
    if (idx === -1) return Response.json({ error: 'Season not found' }, { status: 404, headers: CORS });
    seasons[idx] = { ...seasons[idx], status: 'completed' };
    await kvPut(accountId, apiToken, 'admin:seasons', JSON.stringify(seasons));
    return Response.json({ ok: true, season: seasons[idx] }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
