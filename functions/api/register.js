// Public registration submission. Route: POST /api/register
// Stores a pending signup in registrations:<season>. Email is kept ONLY on this
// season registration record (admin-only read) — never in players:meta, never
// in any public response, never in the repo.
import { checkRateLimit } from './_ratelimit.js';
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

// Restrict CORS to our own origins — registration is a same-origin write, so no
// third-party site needs cross-origin access here. (This doesn't stop curl or
// server-side callers — CORS never does — it stops a malicious website from
// POSTing to this endpoint from one of your players' browsers.)
const ALLOWED_ORIGINS = ['https://mashupgolf.com', 'https://www.mashupgolf.com'];
function corsFor(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?mashup-golf-tour\.pages\.dev$/.test(origin);
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}
async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsFor(context.request) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const json = (obj, status = 200) => Response.json(obj, { status, headers: corsFor(request) });
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return json({ error: 'Storage not configured' }, 500);

  const allowed = await checkRateLimit(accountId, apiToken, request, { keyPrefix: 'ratelimit:register', limit: 5, windowSeconds: 60 });
  if (!allowed) return json({ error: 'Too many attempts. Please wait a minute and try again.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Season must look like a real season id — prevents writing arbitrary
  // `registrations:<anything>` keys (path traversal / KV pollution).
  const season = String(body.season || 'season-10');
  if (!/^season-\d{1,4}$/.test(season)) return json({ error: 'Invalid season.' }, 400);

  const username = String(body.username || '').trim();
  if (!username) return json({ error: 'SGT username is required' }, 400);

  // All three agreements must be accepted.
  const a = body.agreements || {};
  if (!a.livestream || !a.openapi || !a.handicap)
    return json({ error: 'You must accept all agreements to register.' }, 400);

  const changed       = !!body.changed;
  const launchMonitor = String(body.launchMonitor || '').trim();
  const region        = String(body.region || '').trim();
  const email         = String(body.email || '').trim();
  const discordName   = String(body.discordName || '').trim();

  // Length caps so a single record can't be padded to bloat KV storage.
  if (username.length > 40)      return json({ error: 'Username is too long.' }, 400);
  if (discordName.length > 60)   return json({ error: 'Discord name is too long.' }, 400);
  if (region.length > 80)        return json({ error: 'Region is too long.' }, 400);
  if (launchMonitor.length > 80) return json({ error: 'Launch monitor is too long.' }, 400);
  if (email.length > 120)        return json({ error: 'Email is too long.' }, 400);

  const key = `registrations:${season}`;
  const lc = username.toLowerCase();
  const [metaRaw, rosterRaw, listRaw, seasonsRes] = await Promise.all([
    kvGet(accountId, apiToken, 'players:meta'),
    kvGet(accountId, apiToken, 'players:roster'),
    kvGet(accountId, apiToken, key),
    fetch(new URL('/api/seasons', request.url)).catch(() => null),
  ]);
  const meta    = metaRaw   ? JSON.parse(metaRaw)   : {};
  const roster  = rosterRaw ? JSON.parse(rosterRaw) : [];
  const list    = listRaw   ? JSON.parse(listRaw)   : [];
  const seasons = seasonsRes && seasonsRes.ok ? await seasonsRes.json() : [];

  // Decide "returning" from what we actually have on file — NOT the client's
  // flag, which could be set true to skip the new-player required fields.
  const returning = !!meta[lc] || roster.some(n => String(n).toLowerCase() === lc);

  // New players must supply all fields. Returning players who changed something
  // fill in ONLY what's new — every field is optional and a blank keeps what's
  // on file (the admin merges against players:meta on approval). No stored data
  // is ever sent to the browser, so nothing is exposed by username lookup.
  if (!returning) {
    if (!launchMonitor) return json({ error: 'Launch monitor is required.' }, 400);
    if (!region)        return json({ error: 'Region is required.' }, 400);
    if (!email || !/.+@.+\..+/.test(email)) return json({ error: 'A valid email is required.' }, 400);
  } else if (email && !/.+@.+\..+/.test(email)) {
    return json({ error: 'Please enter a valid email, or leave it blank to keep your current one.' }, 400);
  }

  // One active registration per SGT username per season (declined can re-apply).
  // Also blocks re-registering if they're already on this season's roster —
  // a registration record can be deleted (e.g. admin cleanup) while the
  // player stays rostered, and that shouldn't reopen the door to reapplying.
  const thisSeason = seasons.find(s => s.id === season);
  const onSeasonRoster = !!thisSeason && (thisSeason.players || []).some(n => String(n).toLowerCase() === lc);
  if (onSeasonRoster || list.some(r => r.username.toLowerCase() === lc && r.status !== 'declined'))
    return json({ error: 'already-registered', message: `${username} is already registered for this season.` }, 409);

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username, discordName, launchMonitor, region, email,
    agreements: { livestream: true, openapi: true, handicap: true },
    returning, changed,
    status: 'pending', declineReason: '',
    submittedAt: new Date().toISOString(), reviewedAt: null,
  };
  list.push(record);
  await kvPut(accountId, apiToken, key, JSON.stringify(list));

  // Optional Discord ping (no PII — username + region only).
  const webhook = env.DISCORD_REGISTER_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `📝 New registration: **${username}**${region ? ` · ${region}` : ''}${returning && !changed ? ' · returning' : ''} — pending review`, allowed_mentions: { parse: [] } }),
      });
    } catch { /* ping is best-effort */ }
  }

  return json({ ok: true }, 200);
}
