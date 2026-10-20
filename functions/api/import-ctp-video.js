// Fills in a timestamped YouTube link for a recorded CTP winner, when that
// player has linked their stream through SGT's own "Add Streams" modal.
// Route: POST /api/import-ctp-video
// Called by the same scheduled GitHub Actions job that fetches CTP each run
// (fetch-scorecards.yml), via ctp_video_link.py — not a browser, so it's
// gated by a shared secret header instead of Cloudflare Access, same
// pattern as import-sgt-stream.js.
//
// Never overwrites: only ever fills a CTP entry's `video` field when it's
// still empty. A link an admin pasted by hand (or a previous auto-run
// already found) is always left alone — this only ever closes a gap, never
// second-guesses something already on file. Entries this writes are tagged
// `videoSource: 'auto'` so the admin UI can flag them as worth a sanity
// check, distinct from a manually-verified link.
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
  if (!env.STREAM_IMPORT_SECRET || secret !== env.STREAM_IMPORT_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { eventId, items } = body;
  if (!eventId || !Array.isArray(items) || items.length === 0) {
    return Response.json({ error: 'Missing eventId or items' }, { status: 400 });
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500 });

  const applied = [];
  const skipped = [];

  try {
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) return Response.json({ error: 'Unknown event' }, { status: 404 });

    const ctp = Array.isArray(events[idx].ctp) ? [...events[idx].ctp] : [];
    let changed = false;

    for (const item of items) {
      const hole = item.hole;
      const player = String(item.player || '').toLowerCase();
      const video = item.video;
      if (!hole || !player || !video) { skipped.push(item); continue; }

      const ci = ctp.findIndex(c => c.hole === hole && String(c.player || '').toLowerCase() === player);
      if (ci === -1) { skipped.push(item); continue; }
      if (ctp[ci].video) { skipped.push(item); continue; }

      ctp[ci] = { ...ctp[ci], video, videoSource: 'auto' };
      applied.push({ hole, player, video });
      changed = true;
    }

    if (changed) {
      events[idx] = { ...events[idx], ctp };
      await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    }
  } catch (err) {
    return Response.json({ error: `Storage error: ${err.message}` }, { status: 502 });
  }

  return Response.json({ ok: true, applied, skipped });
}
