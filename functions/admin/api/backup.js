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
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

// A dedicated lister (rather than reusing kvList with prefix:'') so the
// "list everything" case doesn't depend on how Cloudflare's API treats an
// empty prefix param — this just omits the param outright.
async function listAllKeys(accountId, apiToken) {
  let cursor = '';
  const keys = [];
  do {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!res.ok) throw new Error(`KV key list failed: ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.result)) keys.push(...data.result);
    cursor = data.result_info && data.result_info.cursor ? data.result_info.cursor : '';
  } while (cursor);
  return keys;
}

// Cloudflare Workers/Pages Functions cap subrequests per invocation (50 on
// the Free plan, 1000 on Paid) — a Promise.all across every key in the
// namespace at once could blow past that once the account has accumulated
// a season or two of registrations/dues/stream-submission keys. Fetch in
// small sequential batches instead so this holds up regardless of plan or
// how large the namespace grows.
const BATCH_SIZE = 20;

async function fetchAllValues(accountId, apiToken, keys) {
  const data = {};
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const values = await Promise.all(batch.map(key => kvGet(accountId, apiToken, key)));
    batch.forEach((key, j) => {
      const raw = values[j];
      if (raw == null) return;
      try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
    });
  }
  return data;
}

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

    if (new URL(request.url).searchParams.get('meta') === '1') {
      const lastExport = await kvGet(accountId, apiToken, 'backup:last_export');
      return Response.json({ lastExport: lastExport || null }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    const allKeys = await listAllKeys(accountId, apiToken);
    const keys = allKeys.map(k => k.name).filter(name => !name.startsWith('ratelimit:'));

    const data = await fetchAllValues(accountId, apiToken, keys);

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
  } catch (e) {
    return Response.json({ error: `Backup failed: ${e.message}` }, { status: 500, headers: CORS });
  }
}
