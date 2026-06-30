// Public registration submission. Route: POST /api/register
// Stores a pending signup in registrations:<season>. Email is kept ONLY on this
// season registration record (admin-only read) — never in players:meta, never
// in any public response, never in the repo.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => Response.json(obj, { status, headers: CORS });

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return json({ error: 'Storage not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const season   = String(body.season || 'season-10');
  const username = String(body.username || '').trim();
  if (!username) return json({ error: 'SGT username is required' }, 400);

  // All three agreements must be accepted.
  const a = body.agreements || {};
  if (!a.livestream || !a.openapi || !a.handicap)
    return json({ error: 'You must accept all agreements to register.' }, 400);

  const returning    = !!body.returning;
  const changed      = !!body.changed;
  const launchMonitor = String(body.launchMonitor || '').trim();
  const region        = String(body.region || '').trim();
  const email         = String(body.email || '').trim();
  const discordName   = String(body.discordName || '').trim();

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

  const key = `registrations:${season}`;
  const raw = await kvGet(accountId, apiToken, key);
  const list = raw ? JSON.parse(raw) : [];

  // One active registration per SGT username per season (declined can re-apply).
  const lc = username.toLowerCase();
  if (list.some(r => r.username.toLowerCase() === lc && r.status !== 'declined'))
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
        body: JSON.stringify({ content: `📝 New registration: **${username}**${region ? ` · ${region}` : ''}${returning && !changed ? ' · returning' : ''} — pending review` }),
      });
    } catch { /* ping is best-effort */ }
  }

  return json({ ok: true }, 200);
}
