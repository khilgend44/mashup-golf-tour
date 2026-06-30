// Protected admin endpoint: post a message to Discord that @-mentions all
// current-season players. Route: POST /admin/api/league-alert
// Use sparingly — it pings the whole league. Posts to the announcements webhook.
import { CORS, kvGet, requireAccess } from './_lib.js';

const stripSub = n => String(n).toLowerCase().replace(/\s*\(sub\)$/, '');
const DISCORD_LIMIT = 1900; // stay safely under Discord's 2000-char message cap

function chunkTags(tags, limit = DISCORD_LIMIT) {
  const chunks = [];
  let cur = '';
  for (const t of tags) {
    if (cur && cur.length + 1 + t.length > limit) { chunks.push(cur); cur = t; }
    else cur = cur ? `${cur} ${t}` : t;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: ['users'] } }), // ping users only — never @everyone/roles
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Discord returned ${res.status}: ${err.message || 'Unknown error'}`);
  }
}

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

  const webhookUrl = env.DISCORD_ANNOUNCE_WEBHOOK_URL;
  if (!webhookUrl) return Response.json({ error: 'DISCORD_ANNOUNCE_WEBHOOK_URL not configured' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const message = String(body.message || '').trim();
  const usernames = Array.isArray(body.usernames) ? body.usernames : [];
  if (!message) return Response.json({ error: 'Message is required.' }, { status: 400, headers: CORS });
  if (!usernames.length) return Response.json({ error: 'No players to tag.' }, { status: 400, headers: CORS });

  // Resolve each season player to their Discord ID.
  const raw = await kvGet(accountId, apiToken, 'players:discord');
  const discord = raw ? JSON.parse(raw) : {};
  const tags = [];
  const missing = [];
  for (const name of usernames) {
    const id = discord[stripSub(name)];
    if (id) tags.push(`<@${id}>`);
    else missing.push(name);
  }

  // Combine message + mentions into one post if it fits; otherwise post the
  // message, then the mentions across as many follow-ups as needed.
  const all = tags.join(' ');
  const messages = (message.length + 2 + all.length) <= 2000 && all.length <= DISCORD_LIMIT
    ? [all ? `${message}\n\n${all}` : message]
    : [message, ...chunkTags(tags)];

  try {
    for (const m of messages) await postToDiscord(webhookUrl, m);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502, headers: CORS });
  }

  return Response.json({ ok: true, posts: messages.length, tagged: tags.length, missing }, { headers: CORS });
}
