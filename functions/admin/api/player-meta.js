// Protected admin endpoint for the persistent player record. Route: /admin/api/player-meta
// GET  → players:meta (admin-only; contains email + pay service).
// POST → 'import' (bulk upsert from a pasted list) or 'set' (one field on one player).
// This data is NEVER returned by any public endpoint and never written to the repo.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

const FIELDS = ['username', 'name', 'discordName', 'email', 'launchMonitor', 'region', 'payService'];

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
  const raw = await kvGet(accountId, apiToken, 'players:meta');
  return Response.json({ meta: raw ? JSON.parse(raw) : {} }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
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

  const raw = await kvGet(accountId, apiToken, 'players:meta');
  const meta = raw ? JSON.parse(raw) : {};
  const now = new Date().toISOString();

  if (body.action === 'import') {
    const players = Array.isArray(body.players) ? body.players : [];
    if (!players.length) return Response.json({ error: 'No players to import' }, { status: 400, headers: CORS });
    let imported = 0;
    for (const p of players) {
      const username = String(p.username || '').trim();
      if (!username) continue;
      const key = username.toLowerCase();
      const prev = meta[key] || {};
      const next = { ...prev, username, updatedAt: now };
      // Only overwrite a field when the import supplies a non-empty value.
      for (const f of FIELDS) {
        if (f === 'username') continue;
        const v = p[f] != null ? String(p[f]).trim() : '';
        if (v) next[f] = v;
      }
      meta[key] = next;
      imported++;
    }
    await kvPut(accountId, apiToken, 'players:meta', JSON.stringify(meta));
    return Response.json({ ok: true, imported, total: Object.keys(meta).length }, { headers: CORS });
  }

  if (body.action === 'set') {
    const username = String(body.username || '').trim();
    const field = String(body.field || '');
    if (!username) return Response.json({ error: 'username required' }, { status: 400, headers: CORS });
    if (!FIELDS.includes(field) || field === 'username') return Response.json({ error: 'invalid field' }, { status: 400, headers: CORS });
    const key = username.toLowerCase();
    const prev = meta[key] || { username };
    meta[key] = { ...prev, username: prev.username || username, [field]: String(body.value ?? '').trim(), updatedAt: now };
    await kvPut(accountId, apiToken, 'players:meta', JSON.stringify(meta));
    return Response.json({ ok: true, player: meta[key] }, { headers: CORS });
  }

  if (body.action === 'delete') {
    const key = String(body.username || '').trim().toLowerCase();
    delete meta[key];
    await kvPut(accountId, apiToken, 'players:meta', JSON.stringify(meta));
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
