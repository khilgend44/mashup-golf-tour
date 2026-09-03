// Protected admin endpoint for season registrations. Route: /admin/api/registrations
// GET  → list registrations (incl. email — admin-only) + players:meta.
// POST → approve / decline / reset / delete a registration.
// On approve, non-email fields are upserted into players:meta (the persistent,
// cross-season player record). Email stays only on the registration record.
//
// Storage: one KV key per registration — registrations:<season>:<lowercaseUsername>:<id>
// — NOT one shared list key. The old shared-list design (one JSON array under
// registrations:<season>) had a read-modify-write race: two registrations
// landing close together could silently clobber each other — confirmed to
// have actually happened in production (2026-09), losing a real registration.
// Each registration now gets its own independent key, so concurrent writes
// can never collide. GET auto-migrates any leftover data still sitting under
// the old shared-list key the first time it's called for a season, then
// deletes that old key — a one-time, self-healing migration, no manual step.
import { CORS, kvGet, kvPut, kvList, kvDelete, requireAccess } from './_lib.js';

function regKey(season, username, id) {
  return `registrations:${season}:${String(username).toLowerCase()}:${id}`;
}

async function loadAllRegistrations(accountId, apiToken, season) {
  const legacyKey = `registrations:${season}`;
  const legacyRaw = await kvGet(accountId, apiToken, legacyKey);
  if (legacyRaw) {
    let legacyList = [];
    try { legacyList = JSON.parse(legacyRaw); } catch { legacyList = []; }
    if (Array.isArray(legacyList) && legacyList.length) {
      await Promise.all(legacyList.map(r =>
        kvPut(accountId, apiToken, regKey(season, r.username, r.id), JSON.stringify(r))
      ));
    }
    await kvDelete(accountId, apiToken, legacyKey);
  }

  const keys = await kvList(accountId, apiToken, `registrations:${season}:`);
  const values = await Promise.all(keys.map(k => kvGet(accountId, apiToken, k.name)));
  return values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);
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

  const season = String(new URL(request.url).searchParams.get('season') || 'season-10');
  const [registrations, metaRaw] = await Promise.all([
    loadAllRegistrations(accountId, apiToken, season),
    kvGet(accountId, apiToken, 'players:meta'),
  ]);
  return Response.json({
    season,
    registrations,
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

  const { action, id, reason, username } = body;
  const season = String(body.season || 'season-10');
  if (!username) return Response.json({ error: 'username required' }, { status: 400, headers: CORS });
  if (!id) return Response.json({ error: 'id required' }, { status: 400, headers: CORS });

  const key = regKey(season, username, id);
  const raw = await kvGet(accountId, apiToken, key);
  if (!raw) return Response.json({ error: 'Registration not found' }, { status: 404, headers: CORS });
  const rec = JSON.parse(raw);
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
      kvPut(accountId, apiToken, key, JSON.stringify(rec)),
    ]);
    return Response.json({ ok: true, registration: rec, meta: meta[lc] }, { headers: CORS });
  }

  if (action === 'decline') {
    rec.status = 'declined';
    rec.declineReason = String(reason || '').trim();
    rec.reviewedAt = now;
    await kvPut(accountId, apiToken, key, JSON.stringify(rec));

    // Same channel as the new-registration ping — a searchable record of why
    // someone was declined, for looking back later.
    const webhook = env.DISCORD_REGISTER_WEBHOOK_URL;
    if (webhook) {
      try {
        await fetch(webhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ Declined: **${rec.username}** for ${season.replace('season-', 'Season ')}${rec.declineReason ? ` — ${rec.declineReason}` : ' (no reason given)'}`,
            allowed_mentions: { parse: [] },
          }),
        });
      } catch { /* ping is best-effort */ }
    }

    return Response.json({ ok: true, registration: rec }, { headers: CORS });
  }

  if (action === 'reset') {            // back to pending
    rec.status = 'pending';
    rec.declineReason = '';
    rec.reviewedAt = null;
    await kvPut(accountId, apiToken, key, JSON.stringify(rec));
    return Response.json({ ok: true, registration: rec }, { headers: CORS });
  }

  if (action === 'delete') {
    await kvDelete(accountId, apiToken, key);
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
