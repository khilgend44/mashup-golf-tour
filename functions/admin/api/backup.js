// Protected admin endpoint: full KV namespace export. Route: /admin/api/backup
// GET                → every KV key/value in the namespace, as one downloadable JSON file.
// GET ?meta=1        → just { lastExport } — when the last download happened, for the UI.
//
// This project's KV namespace is the one datastore behind the site that
// ISN'T already safe in git — the code, static data, and scorecard history
// all live in this (public) GitHub repo and would survive a total Cloudflare
// loss on their own. Player emails/Discord IDs, registrations, dues records,
// and event payouts live only here. ratelimit:* keys are excluded — 60s-TTL
// counters with nothing worth preserving.
import { CORS, kvGet, kvPut, kvList, requireAccess } from './_lib.js';

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

  if (new URL(request.url).searchParams.get('meta') === '1') {
    const lastExport = await kvGet(accountId, apiToken, 'backup:last_export');
    return Response.json({ lastExport: lastExport || null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  const allKeys = await kvList(accountId, apiToken, '');
  const keys = allKeys.map(k => k.name).filter(name => !name.startsWith('ratelimit:'));

  const values = await Promise.all(keys.map(key => kvGet(accountId, apiToken, key)));
  const data = {};
  keys.forEach((key, i) => {
    const raw = values[i];
    if (raw == null) return;
    try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
  });

  const now = new Date().toISOString();
  try { await kvPut(accountId, apiToken, 'backup:last_export', now); } catch { /* metadata is best-effort */ }

  const filename = `mashup-backup-${now.slice(0, 10)}.json`;
  return new Response(JSON.stringify({ exportedAt: now, keyCount: keys.length, data }, null, 2), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
