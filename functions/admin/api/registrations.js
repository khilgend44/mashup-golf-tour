// Protected admin endpoint for season registrations. Route: /admin/api/registrations
// GET  → list registrations (incl. email — admin-only) + players:meta.
// POST → approve / decline / reset / delete a registration.
// On approve, non-email fields are upserted into players:meta (the persistent,
// cross-season player record). Email stays only on the registration record.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

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

  const season = String(new URL(request.url).searchParams.get('season') || 'season-10');
  const [regRaw, metaRaw] = await Promise.all([
    kvGet(accountId, apiToken, `registrations:${season}`),
    kvGet(accountId, apiToken, 'players:meta'),
  ]);
  return Response.json({
    season,
    registrations: regRaw ? JSON.parse(regRaw) : [],
    meta: metaRaw ? JSON.parse(metaRaw) : {},
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
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

  const { action, id, reason } = body;
  const season = String(body.season || 'season-10');
  const key = `registrations:${season}`;
  const raw = await kvGet(accountId, apiToken, key);
  const list = raw ? JSON.parse(raw) : [];
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) return Response.json({ error: 'Registration not found' }, { status: 404, headers: CORS });
  const rec = list[idx];
  const now = new Date().toISOString();

  if (action === 'approve') {
    rec.status = 'approved';
    rec.declineReason = '';
    rec.reviewedAt = now;
    // Upsert persistent meta (NO email).
    const metaRaw = await kvGet(accountId, apiToken, 'players:meta');
    const meta = metaRaw ? JSON.parse(metaRaw) : {};
    const lc = rec.username.toLowerCase();
    const prev = meta[lc] || {};
    meta[lc] = {
      ...prev,                                       // preserves admin-entered fields like name
      username:      rec.username,
      launchMonitor: rec.launchMonitor || prev.launchMonitor || '',
      region:        rec.region || prev.region || '',
      discordName:   rec.discordName || prev.discordName || '',
      email:         rec.email || prev.email || '',  // admin-only; never public
      updatedAt:     now,
    };
    await Promise.all([
      kvPut(accountId, apiToken, 'players:meta', JSON.stringify(meta)),
      kvPut(accountId, apiToken, key, JSON.stringify(list)),
    ]);
    return Response.json({ ok: true, registration: rec, meta: meta[lc] }, { headers: CORS });
  }

  if (action === 'decline') {
    rec.status = 'declined';
    rec.declineReason = String(reason || '').trim();
    rec.reviewedAt = now;
    await kvPut(accountId, apiToken, key, JSON.stringify(list));
    return Response.json({ ok: true, registration: rec }, { headers: CORS });
  }

  if (action === 'reset') {            // back to pending
    rec.status = 'pending';
    rec.declineReason = '';
    rec.reviewedAt = null;
    await kvPut(accountId, apiToken, key, JSON.stringify(list));
    return Response.json({ ok: true, registration: rec }, { headers: CORS });
  }

  if (action === 'delete') {
    list.splice(idx, 1);
    await kvPut(accountId, apiToken, key, JSON.stringify(list));
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
