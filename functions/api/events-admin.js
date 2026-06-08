const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  const params = new URL(request.url).searchParams;
  const type = params.get('type');

  // ── Scrape event name from SGT page ──────────────────────
  if (type === 'scrape') {
    const tournamentId = params.get('tournamentId');
    if (!tournamentId) return Response.json({ error: 'Missing tournamentId' }, { status: 400, headers: CORS });
    try {
      const sgtRes = await fetch(`https://simulatorgolftour.com/tournament/${tournamentId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!sgtRes.ok) return Response.json({ name: null, error: `SGT returned ${sgtRes.status}` }, { headers: CORS });
      const html = await sgtRes.text();

      // Try to match "MASHUP S8W2 - SOLO RINGER" style pattern
      const patterns = [
        /MASHUP\s+S\d+W\d+\s*[-–]\s*([A-Z][A-Z0-9\s''&]+?)(?:\s*[<"|])/i,
        /MASHUP\s+S\d+W\d+\s*[-–]\s*([A-Z][A-Z0-9\s''&]+)/i,
        /<title[^>]*>([^<]*MASHUP[^<]*)<\/title>/i,
        /<h1[^>]*>([^<]*MASHUP[^<]*)<\/h1>/i,
        /<h2[^>]*>([^<]*MASHUP[^<]*)<\/h2>/i,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          const raw = (match[1] || match[0]).trim().replace(/\s+/g, ' ');
          // Return just what the full match captured, cleaned up
          const full = html.match(/MASHUP\s+S\d+W\d+\s*[-–]\s*[A-Z0-9][A-Z0-9\s''&-]*/i);
          const name = full ? full[0].trim().replace(/\s+/g, ' ') : raw;
          return Response.json({ name }, { headers: CORS });
        }
      }

      return Response.json({ name: null, error: 'Event name not found on page' }, { headers: CORS });
    } catch (e) {
      return Response.json({ name: null, error: e.message }, { headers: CORS });
    }
  }

  try {
    const [eventsRaw, formatsRaw] = await Promise.all([
      type !== 'formats' ? kvGet(accountId, apiToken, 'admin:events')  : Promise.resolve(null),
      type !== 'events'  ? kvGet(accountId, apiToken, 'admin:formats') : Promise.resolve(null),
    ]);

    if (type === 'events')  return Response.json(eventsRaw  ? JSON.parse(eventsRaw)  : [],  { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    if (type === 'formats') return Response.json(formatsRaw ? JSON.parse(formatsRaw) : {},  { headers: { ...CORS, 'Cache-Control': 'no-store' } });

    return Response.json({
      events:  eventsRaw  ? JSON.parse(eventsRaw)  : [],
      formats: formatsRaw ? JSON.parse(formatsRaw) : {},
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const { action } = body;

  // ── Events ──────────────────────────────────────────────────
  if (action === 'create-event') {
    const { event } = body;
    if (!event || !event.id) return Response.json({ error: 'Missing event data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    if (events.find(e => e.id === event.id))
      return Response.json({ error: `Event ${event.id} already exists` }, { status: 409, headers: CORS });
    events.push(event);
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event }, { headers: CORS });
  }

  if (action === 'update-event') {
    const { event } = body;
    if (!event || !event.id) return Response.json({ error: 'Missing event data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === event.id);
    if (idx === -1) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });
    events[idx] = event;
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event }, { headers: CORS });
  }

  if (action === 'delete-event') {
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const updated = events.filter(e => e.id !== eventId);
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(updated));
    return Response.json({ ok: true }, { headers: CORS });
  }

  // ── Formats ─────────────────────────────────────────────────
  if (action === 'create-format') {
    const { format } = body;
    if (!format || !format.id) return Response.json({ error: 'Missing format data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:formats');
    const formats = raw ? JSON.parse(raw) : {};
    formats[format.id] = format;
    await kvPut(accountId, apiToken, 'admin:formats', JSON.stringify(formats));
    return Response.json({ ok: true, format }, { headers: CORS });
  }

  if (action === 'delete-format') {
    const { formatId } = body;
    if (!formatId) return Response.json({ error: 'Missing formatId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:formats');
    const formats = raw ? JSON.parse(raw) : {};
    delete formats[formatId];
    await kvPut(accountId, apiToken, 'admin:formats', JSON.stringify(formats));
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
