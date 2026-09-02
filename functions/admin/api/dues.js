// Protected admin endpoint for season dues tracking. Route: /admin/api/dues
// GET  → dues:<season> for one season (admin-only).
// POST → 'set' (one field on one player, for a given season).
// Dues are season-scoped (a new $-amount is due each season) — separate from
// players:meta's payService, which just records a player's usual payment app.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

const FIELDS = ['paid', 'datePaid', 'service', 'amount'];

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  const season = String(new URL(request.url).searchParams.get('season') || '').trim();
  if (!season) return Response.json({ error: 'season required' }, { status: 400, headers: CORS });

  const raw = await kvGet(accountId, apiToken, `dues:${season}`);
  return Response.json({ season, dues: raw ? JSON.parse(raw) : {} }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
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

  const season = String(body.season || '').trim();
  const username = String(body.username || '').trim();
  const field = String(body.field || '');
  if (!season) return Response.json({ error: 'season required' }, { status: 400, headers: CORS });
  if (!username) return Response.json({ error: 'username required' }, { status: 400, headers: CORS });
  if (body.action !== 'set') return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
  if (!FIELDS.includes(field)) return Response.json({ error: 'invalid field' }, { status: 400, headers: CORS });

  const key = `dues:${season}`;
  const raw = await kvGet(accountId, apiToken, key);
  const dues = raw ? JSON.parse(raw) : {};
  const lc = username.toLowerCase();
  const prev = dues[lc] || { username };

  let value = body.value;
  if (field === 'paid') value = !!value;
  else if (field === 'amount') value = value === '' || value == null ? null : Number(value);
  else value = value ? String(value).trim() : '';

  dues[lc] = { ...prev, username: prev.username || username, [field]: value, updatedAt: new Date().toISOString() };
  await kvPut(accountId, apiToken, key, JSON.stringify(dues));
  return Response.json({ ok: true, player: dues[lc] }, { headers: CORS });
}
