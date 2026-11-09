// Protected admin endpoint for tracking money PAID OUT to winners — the
// mirror image of dues.js (which tracks money collected IN). Route:
// /admin/api/payouts
// GET  -> every player's payout record for one season (admin-only).
// POST -> 'set' (one field on one player, for a given season).
//
// Storage: one KV key per player per season — payouts:<season>:<lowercaseUsername>
// — same per-player-key shape as dues.js, for the same reason: a shared
// per-season blob would reintroduce the read-modify-write race already
// found (and fixed) in registrations.js/dues.js, where two field writes
// landing close together silently clobber each other.
//
// `amount` is admin-entered (prefilled client-side from the live scoring
// engine's computed total, but stored once confirmed) rather than derived
// live on every read — an audit trail should record what was actually paid
// at the time, not a number that could silently drift if scoring logic
// ever changes later.
import { CORS, kvGet, kvPut, kvList, requireAccess } from './_lib.js';

const FIELDS = ['paid', 'datePaid', 'service', 'amount', 'notes'];
const NUMERIC_FIELDS = ['amount'];

function payoutKey(season, username) {
  return `payouts:${season}:${String(username).toLowerCase()}`;
}

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

  const keys = await kvList(accountId, apiToken, `payouts:${season}:`);
  const values = await Promise.all(keys.map(k => kvGet(accountId, apiToken, k.name)));
  const payouts = {};
  for (const v of values) {
    if (!v) continue;
    try {
      const rec = JSON.parse(v);
      if (rec && rec.username) payouts[rec.username.toLowerCase()] = rec;
    } catch { /* skip malformed */ }
  }

  return Response.json({ season, payouts }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
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

  const key = payoutKey(season, username);
  const raw = await kvGet(accountId, apiToken, key);
  const prev = raw ? JSON.parse(raw) : { username };

  let value = body.value;
  if (field === 'paid') value = !!value;
  else if (NUMERIC_FIELDS.includes(field)) value = value === '' || value == null ? null : Number(value);
  else value = value ? String(value).trim() : '';

  const rec = { ...prev, username: prev.username || username, [field]: value, updatedAt: new Date().toISOString() };
  await kvPut(accountId, apiToken, key, JSON.stringify(rec));
  return Response.json({ ok: true, player: rec }, { headers: CORS });
}
