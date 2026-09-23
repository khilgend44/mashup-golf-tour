// Public "notify me for next season" signup. Route: POST /api/interest
// Used on registration.html while registration is closed — a lightweight
// heads-up list, NOT a real registration (no review/approve flow, no
// SGT username lookup). Stored as its own KV key per submission —
// interest:<bucket>:<timestamp>:<random> — same one-key-per-record shape
// as registrations, so concurrent submissions can never clobber each other.
import { checkRateLimit } from './_ratelimit.js';
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

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

  const allowed = await checkRateLimit(accountId, apiToken, request, { keyPrefix: 'ratelimit:interest', limit: 5, windowSeconds: 60 });
  if (!allowed) return json({ error: 'Too many attempts. Please wait a minute and try again.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Bucket must look like a real season id — same guard as /api/register,
  // prevents writing arbitrary `interest:<anything>` keys.
  const bucket = String(body.bucket || 'season-11');
  if (!/^season-\d{1,4}$/.test(bucket)) return json({ error: 'Invalid season.' }, 400);

  const name  = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const note  = String(body.note || '').trim();
  if (!name)  return json({ error: 'Name or SGT username is required.' }, 400);
  if (!email || !/.+@.+\..+/.test(email)) return json({ error: 'A valid email is required.' }, 400);

  if (name.length > 60)  return json({ error: 'Name is too long.' }, 400);
  if (email.length > 120) return json({ error: 'Email is too long.' }, 400);
  if (note.length > 500)  return json({ error: 'Note is too long.' }, 400);

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const record = { id, name, email, note, submittedAt: new Date().toISOString() };
  await kvPut(accountId, apiToken, `interest:${bucket}:${id}`, JSON.stringify(record));

  const webhook = env.DISCORD_REGISTER_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `👋 Season 11 interest: **${name}** — will reach out when registration opens`, allowed_mentions: { parse: [] } }),
      });
    } catch { /* ping is best-effort */ }
  }

  return json({ ok: true }, 200);
}
