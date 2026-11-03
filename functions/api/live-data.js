// Serves live scorecard/CTP/CTP-video data for a currently-active event
// straight from Cloudflare KV, instead of the git-committed static files
// under /data/ — written by fetch-scorecards.yml directly via the
// Cloudflare API (same CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN secrets
// documented for this in ARCHITECTURE.md, previously unused by any
// workflow), not by a git commit. This is what lets that workflow stop
// committing a redeploy-triggering file every ~11 minutes: an active
// event's data lives here until the event completes, at which point it's
// finalized to the static file + committed once (the workflow's "Finalize
// completed events" step) and these keys are cleared. A historical event
// (pre-dating this change, or already finalized) simply has no key here —
// js/api.js falls back to the static file on a miss, so nothing changes
// for old data.
//
// Read-only by design — the write side lives entirely in
// fetch-scorecards.yml, which already has CLOUDFLARE_ACCOUNT_ID/
// CLOUDFLARE_API_TOKEN as GitHub Actions secrets and talks to
// api.cloudflare.com directly, the same way every other KV write in this
// workflow already does (see import-sgt-stream.js/import-ctp-video.js for
// the equivalent pattern from inside a Function instead). No secret-gated
// POST endpoint needed here since nothing else ever needs to write these
// keys.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';
const TYPES = new Set(['scorecards', 'ctp', 'ctp-video']);

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const tid = url.searchParams.get('tid');

  if (!TYPES.has(type) || !tid) {
    return Response.json({ error: 'type must be scorecards|ctp|ctp-video, tid required' }, { status: 400 });
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return new Response('', { status: 404 });

  let value;
  try {
    value = await kvGet(accountId, apiToken, `${type}:${tid}`);
  } catch {
    return new Response('', { status: 404 });
  }
  if (value == null) return new Response('', { status: 404, headers: { 'Cache-Control': 'no-cache' } });

  // Same no-cache intent the static /data/scorecards/* path already has
  // via _headers — this is live, frequently-changing data, never meant to
  // be cached by an intermediate layer.
  return new Response(value, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
}
