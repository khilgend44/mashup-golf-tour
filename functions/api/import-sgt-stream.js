// Backfills stream links players posted directly on SGT's own tournament
// page (its "Add Streams" modal) instead of through MashUp's submission
// form, so they still get a stream icon/link on MashUp's leaderboard.
// Route: POST /api/import-sgt-stream
// Called by the same scheduled GitHub Actions job that already fetches CTP
// each run (fetch-scorecards.yml) — not a browser, so it's gated by a
// shared secret header instead of Cloudflare Access, same pattern as
// approval-digest.js.
//
// Never overwrites: this only ever fills a `${eventId}:${player}:${round}`
// key that doesn't exist yet. A player who submits (or re-submits) through
// MashUp directly is always the source of truth for that key — SGT is only
// consulted to fill a gap MashUp has never seen, never to second-guess
// something already on file.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

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
    body: value,
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const secret = request.headers.get('X-Cron-Secret') || '';
  if (!env.DIGEST_CRON_SECRET || secret !== env.DIGEST_CRON_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { eventId, eventName, items } = body;
  if (!eventId || !Array.isArray(items) || items.length === 0) {
    return Response.json({ error: 'Missing eventId or items' }, { status: 400 });
  }

  const accountId  = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken   = env.CLOUDFLARE_API_TOKEN;
  const webhookUrl = env.DISCORD_STREAMS_WEBHOOK_URL;
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500 });

  // Same validation as submit-stream.js — only write keys for a real event
  // and a player actually in that event's field, so a bad eventId/player
  // from the scraper can't seed arbitrary KV keys.
  let event, roster;
  try {
    const [eventsRaw, rosterRaw] = await Promise.all([
      kvGet(accountId, apiToken, 'admin:events'),
      kvGet(accountId, apiToken, 'players:roster'),
    ]);
    const events = eventsRaw ? JSON.parse(eventsRaw) : [];
    event  = events.find(e => e.id === eventId);
    roster = rosterRaw ? JSON.parse(rosterRaw) : [];
  } catch {
    return Response.json({ error: 'Could not verify event' }, { status: 502 });
  }
  if (!event) return Response.json({ error: 'Unknown event' }, { status: 404 });

  const allowed = new Set([
    ...roster.map(n => String(n).toLowerCase()),
    ...((event.teams || []).flat().map(n => String(n).toLowerCase())),
  ]);

  const imported = [];
  const skipped = [];
  const invalid = [];

  try {
    for (const item of items) {
      const player = String(item.player || '').toLowerCase();
      const round = item.round;
      const url = item.url;
      if (!player || !round || !url || !allowed.has(player)) {
        invalid.push(item);
        continue;
      }
      const key = `${eventId}:${player}:${round}`;
      const existing = await kvGet(accountId, apiToken, key);
      if (existing) {
        skipped.push({ player, round });
        continue;
      }
      await kvPut(accountId, apiToken, key, url);
      imported.push({ player, round, url });
    }

    if (imported.length && webhookUrl) {
      const lines = imported.map(i => `• **${i.player}** Round ${i.round}: ${i.url}`);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `📡 Found stream(s) posted directly on SGT (not submitted on MashUp) for **${eventName || eventId}**:\n${lines.join('\n')}`,
          allowed_mentions: { parse: [] },
        }),
      });
    }
  } catch (err) {
    return Response.json({ error: `Storage error: ${err.message}` }, { status: 502 });
  }

  return Response.json({ ok: true, imported, skipped, invalid });
}
