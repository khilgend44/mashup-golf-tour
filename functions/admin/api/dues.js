// Protected admin endpoint for season dues tracking. Route: /admin/api/dues
// GET  → every player's dues for one season (admin-only).
// POST → 'set' (one field on one player, for a given season).
//
// Storage: one KV key per player per season — dues:<season>:<lowercaseUsername>
// — NOT one shared JSON blob per season. A shared blob had the same
// read-modify-write race already found (and fixed) in registrations.js:
// two field writes landing close together silently clobber each other.
// Confirmed happening here too (2026-09) — checking a player's "Paid" box
// also auto-fills Date Paid in the same click, firing two saves back-to-back,
// and one would sometimes overwrite the other, dropping a field (and the
// dues summary/count with it, since it reads the dropped field).
// GET auto-migrates any leftover data under the old shared-blob key the
// first time it's called for a season, then deletes that key.
//
// `carryOver` is a permanent record of a players:meta creditBalance that was
// applied (and cleared) during this season's dues collection — written once,
// meant to stay as a historical record and not be edited again.
import { CORS, kvGet, kvPut, kvList, kvDelete, requireAccess } from './_lib.js';

const FIELDS = ['paid', 'datePaid', 'service', 'amount', 'carryOver'];
const NUMERIC_FIELDS = ['amount', 'carryOver'];

function duesKey(season, username) {
  return `dues:${season}:${String(username).toLowerCase()}`;
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

  // One-time migration: fold any legacy shared-blob data into per-player
  // keys, then remove the old key so this only ever runs once per season.
  const legacyKey = `dues:${season}`;
  const legacyRaw = await kvGet(accountId, apiToken, legacyKey);
  if (legacyRaw) {
    let legacy = {};
    try { legacy = JSON.parse(legacyRaw); } catch { legacy = {}; }
    const entries = Object.values(legacy).filter(r => r && r.username);
    if (entries.length) {
      await Promise.all(entries.map(rec =>
        kvPut(accountId, apiToken, duesKey(season, rec.username), JSON.stringify(rec))
      ));
    }
    await kvDelete(accountId, apiToken, legacyKey);
  }

  const keys = await kvList(accountId, apiToken, `dues:${season}:`);
  const values = await Promise.all(keys.map(k => kvGet(accountId, apiToken, k.name)));
  const dues = {};
  for (const v of values) {
    if (!v) continue;
    try {
      const rec = JSON.parse(v);
      if (rec && rec.username) dues[rec.username.toLowerCase()] = rec;
    } catch { /* skip malformed */ }
  }

  return Response.json({ season, dues }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
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

  const key = duesKey(season, username);
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
