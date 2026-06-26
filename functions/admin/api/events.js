// Protected admin WRITE endpoint for events + formats.  Route: /admin/api/events
// Reads (list/scrape) remain public at /api/events-admin.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

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

  if (action === 'activate-event') {
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });
    if (events[idx].status === 'active') return Response.json({ error: 'Event is already active' }, { status: 409, headers: CORS });
    events[idx] = { ...events[idx], status: 'active' };
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    // Snapshot current handicaps for this event
    const handicapsRaw = await kvGet(accountId, apiToken, 'players:handicaps');
    if (handicapsRaw) {
      await kvPut(accountId, apiToken, `${eventId}:handicaps`, handicapsRaw);
    }
    return Response.json({ ok: true, event: events[idx] }, { headers: CORS });
  }

  if (action === 'complete-event') {
    const { eventId, ctp } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });
    const updated = { ...events[idx], status: 'completed' };
    // Recorded CTP winners: [{ hole, player, distance, amount }]
    if (Array.isArray(ctp)) updated.ctp = ctp;
    events[idx] = updated;
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event: events[idx] }, { headers: CORS });
  }

  if (action === 'set-devils-draw') {
    const { eventId, devilsDraw, revealOrder } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    if (!devilsDraw || typeof devilsDraw !== 'object')
      return Response.json({ error: 'Missing devilsDraw' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) return Response.json({ error: 'Event not found in KV (static events are edited in data/events.json)' }, { status: 404, headers: CORS });
    events[idx] = {
      ...events[idx],
      devilsDraw,
      revealOrder: Array.isArray(revealOrder) && revealOrder.length ? revealOrder : Object.values(devilsDraw).flat(),
    };
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event: events[idx] }, { headers: CORS });
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
