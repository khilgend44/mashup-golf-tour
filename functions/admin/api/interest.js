// Admin-only view of the "notify me for next season" interest list gathered
// while registration.html shows its closed state. Route: /admin/api/interest
// GET    → list entries for a bucket (default season-11).
// DELETE → remove one entry (e.g. after reaching out), pass { bucket, id }.
import { CORS, kvGet, kvList, kvDelete, requireAccess } from './_lib.js';

function interestKey(bucket, id) {
  return `interest:${bucket}:${id}`;
}

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

  const bucket = String(new URL(request.url).searchParams.get('bucket') || 'season-11');
  const keys = await kvList(accountId, apiToken, `interest:${bucket}:`);
  const values = await Promise.all(keys.map(k => kvGet(accountId, apiToken, k.name)));
  const entries = values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''));

  return Response.json({ bucket, entries }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

// Only DELETE is needed — this list has no approve/decline workflow, just
// "remove once contacted."
export async function onRequestDelete(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }
  const bucket = String(body.bucket || 'season-11');
  const id = body.id;
  if (!id) return Response.json({ error: 'id required' }, { status: 400, headers: CORS });

  await kvDelete(accountId, apiToken, interestKey(bucket, id));
  return Response.json({ ok: true }, { headers: CORS });
}
