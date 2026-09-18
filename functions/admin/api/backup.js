// Protected admin endpoint: full KV namespace export. Route: /admin/api/backup
// GET ?meta=1          → { lastExport } — when the last download happened, for the UI.
// GET ?listKeys=1      → every KV key name (minus ratelimit:* noise).
// GET ?keys=a,b,c       → values for a client-given batch of keys (max 45/call).
// GET ?markExported=1  → records that a backup was just downloaded.
//
// Deliberately client-driven in small batches rather than one server-side
// fetch-everything call: a full KV namespace easily exceeds the Workers/Pages
// per-invocation subrequest cap (50 on the Free plan — confirmed hit here)
// once it's accumulated a season or two of registration/dues/stream keys.
// admin/backup.html lists all keys first, then fetches values in bounded
// chunks and assembles the final file client-side.
//
// This project's KV namespace is the one datastore behind the site that
// ISN'T already safe in git — the code, static data, and scorecard history
// all live in this (public) GitHub repo and would survive a total Cloudflare
// loss on their own. Player emails/Discord IDs, registrations, dues records,
// and event payouts live only here.
import { CORS, kvGet, kvPut, kvList, requireAccess } from './_lib.js';

const MAX_KEYS_PER_BATCH = 45;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const denied = await requireAccess(request, env);
    if (denied) return denied;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken  = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

    const params = new URL(request.url).searchParams;

    if (params.get('meta') === '1') {
      const lastExport = await kvGet(accountId, apiToken, 'backup:last_export');
      return Response.json({ lastExport: lastExport || null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    if (params.get('listKeys') === '1') {
      const allKeys = await kvList(accountId, apiToken, '');
      const keys = allKeys.map(k => k.name).filter(name => !name.startsWith('ratelimit:'));
      return Response.json({ keys }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    const keysParam = params.get('keys');
    if (keysParam != null) {
      const keys = keysParam.split(',').map(k => k.trim()).filter(Boolean);
      if (keys.length === 0) return Response.json({ data: {} }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
      if (keys.length > MAX_KEYS_PER_BATCH) {
        return Response.json({ error: `Too many keys in one batch (max ${MAX_KEYS_PER_BATCH})` }, { status: 400, headers: CORS });
      }
      const values = await Promise.all(keys.map(key => kvGet(accountId, apiToken, key)));
      const data = {};
      keys.forEach((key, i) => {
        const raw = values[i];
        if (raw == null) return;
        try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
      });
      return Response.json({ data }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    if (params.get('markExported') === '1') {
      const now = new Date().toISOString();
      await kvPut(accountId, apiToken, 'backup:last_export', now);
      return Response.json({ ok: true, exportedAt: now }, { headers: CORS });
    }

    return Response.json({ error: 'Unknown request — use listKeys=1, keys=<list>, markExported=1, or meta=1' }, { status: 400, headers: CORS });
  } catch (e) {
    return Response.json({ error: `Backup failed: ${e.message}` }, { status: 500, headers: CORS });
  }
}
