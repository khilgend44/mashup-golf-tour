// Daily digest: announces newly-approved season registrations to Discord.
// Route: POST /api/approval-digest
// Called by a scheduled GitHub Actions job (not a browser), so it's gated by
// a shared secret header instead of Cloudflare Access. Posts to the same
// webhook as League Alert (DISCORD_ANNOUNCE_WEBHOOK_URL).
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

async function kvListKeys(accountId, apiToken, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

const stripSub = n => String(n).toLowerCase().replace(/\s*\(sub\)$/, '');

export async function onRequestPost(context) {
  const { request, env } = context;

  // Shared-secret auth — this endpoint is called by a cron job, not a signed-in
  // admin, so it can't go through Cloudflare Access like the rest of /admin/api/*.
  const secret = request.headers.get('X-Cron-Secret') || '';
  if (!env.DIGEST_CRON_SECRET || secret !== env.DIGEST_CRON_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const accountId  = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken   = env.CLOUDFLARE_API_TOKEN;
  const webhookUrl = env.DISCORD_ANNOUNCE_WEBHOOK_URL;
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500 });
  if (!webhookUrl) return Response.json({ error: 'DISCORD_ANNOUNCE_WEBHOOK_URL not configured' }, { status: 500 });

  let activeSeason;
  try {
    const res = await fetch(new URL('/api/seasons', request.url));
    const seasons = res.ok ? await res.json() : [];
    activeSeason = seasons.find(s => s.status === 'active');
  } catch { /* falls through to the check below */ }
  if (!activeSeason) return Response.json({ ok: true, skipped: 'no active season' });

  const season    = activeSeason.id;
  const cursorKey = `digest:${season}:lastRun`;
  const now = new Date().toISOString();

  const [cursor, regKeys, discordRaw] = await Promise.all([
    kvGet(accountId, apiToken, cursorKey),
    // Registrations live one-per-key (registrations:<season>:<user>:<id>),
    // not a shared list — see functions/admin/api/registrations.js for why.
    kvListKeys(accountId, apiToken, `registrations:${season}:`),
    kvGet(accountId, apiToken, 'players:discord'),
  ]);

  // First-ever run for this season: seed the cursor silently instead of
  // announcing every registration approved so far.
  if (!cursor) {
    await kvPut(accountId, apiToken, cursorKey, now);
    return Response.json({ ok: true, seeded: true });
  }

  const regValues = await Promise.all(regKeys.map(k => kvGet(accountId, apiToken, k.name)));
  const regs = regValues
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);
  const discord = discordRaw ? JSON.parse(discordRaw) : {};
  const newlyApproved = regs.filter(r => r.status === 'approved' && r.reviewedAt && r.reviewedAt > cursor);

  await kvPut(accountId, apiToken, cursorKey, now);

  if (!newlyApproved.length) return Response.json({ ok: true, posted: 0 });

  const names = newlyApproved.map(r => {
    const id = discord[stripSub(r.username)];
    return id ? `<@${id}>` : `**${r.username}**`;
  });
  const contact = env.DUES_CONTACT_MENTION || 'an admin';
  const content = `✅ Approved for ${activeSeason.name}: ${names.join(', ')}\nDM ${contact} for payment instructions. Note: Payment Account is the same as in seasons past.`;

  const dres = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: ['users'] } }),
  });
  if (!dres.ok) return Response.json({ error: `Discord returned ${dres.status}` }, { status: 502 });

  return Response.json({ ok: true, posted: newlyApproved.length, players: newlyApproved.map(r => r.username) });
}
