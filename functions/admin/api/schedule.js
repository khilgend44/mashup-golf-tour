// Protected admin WRITE endpoint for the season schedule (planned weeks that
// don't have a real event yet). Route: /admin/api/schedule
// Public read lives at /api/schedule.
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
  const raw = await kvGet(accountId, apiToken, 'admin:schedule');
  const entries = raw ? JSON.parse(raw) : [];

  if (action === 'save-week') {
    const { entry } = body;
    if (!entry || !entry.season || !entry.week) return Response.json({ error: 'Missing season/week' }, { status: 400, headers: CORS });
    if (!entry.formatName) return Response.json({ error: 'Missing format name' }, { status: 400, headers: CORS });

    const week = parseInt(entry.week, 10);
    if (!Number.isInteger(week) || week < 1) return Response.json({ error: 'Invalid week number' }, { status: 400, headers: CORS });

    const id = `${entry.season}-w${week}`;
    const saved = {
      id, season: entry.season, week,
      formatName: String(entry.formatName).trim().slice(0, 80),
      dateLabel:  String(entry.dateLabel  || '').trim().slice(0, 40),
      note:       String(entry.note       || '').trim().slice(0, 140),
    };
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) entries.push(saved); else entries[idx] = saved;

    await kvPut(accountId, apiToken, 'admin:schedule', JSON.stringify(entries));
    return Response.json({ ok: true, entry: saved }, { headers: CORS });
  }

  if (action === 'delete-week') {
    const { season, week } = body;
    if (!season || !week) return Response.json({ error: 'Missing season/week' }, { status: 400, headers: CORS });
    const id = `${season}-w${parseInt(week, 10)}`;
    const next = entries.filter(e => e.id !== id);
    await kvPut(accountId, apiToken, 'admin:schedule', JSON.stringify(next));
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400, headers: CORS });
}
