// Protected admin WRITE endpoint for events + formats.  Route: /admin/api/events
// Reads (list/scrape) remain public at /api/events-admin.
import { CORS, kvGet, kvPut, requireAccess, resolveCourseIds } from './_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Long-term per-player MashCAP trend, independent of SGT's ~48-round rolling
// combo window (players:rounds gets trimmed to that window on every refresh,
// so it can never show more than a few months of history no matter how long
// a player's career gets). One point per *event*, not per round — recorded
// from the same handicaps blob already snapshotted at activation time into
// `${event.id}:handicaps`, so this never requires a second source of truth.
// Pure (no KV I/O) so both the activation hook and the backfill below share
// one implementation and one upsert-by-eventId rule (never duplicates a
// point if an event is somehow processed twice).
function recordMashCapPoint(history, event, handicapsObj) {
  if (!event || !handicapsObj) return;
  for (const key of Object.keys(handicapsObj)) {
    const mashCap = handicapsObj[key]?.mashCap;
    if (mashCap == null) continue;
    if (!history[key]) history[key] = [];
    const point = {
      eventId: event.id,
      season: event.season || null,
      week: event.week ?? null,
      date: event.date || new Date().toISOString().slice(0, 10),
      mashCap: Number(mashCap),
    };
    const idx = history[key].findIndex(h => h.eventId === event.id);
    if (idx !== -1) history[key][idx] = point; else history[key].push(point);
  }
}

function sortMashCapHistory(history) {
  for (const key of Object.keys(history)) {
    history[key].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
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
    if (Array.isArray(event.rounds)) event.rounds = await resolveCourseIds(event.rounds);
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    if (events.find(e => e.id === event.id))
      return Response.json({ error: `Event ${event.id} already exists` }, { status: 409, headers: CORS });
    events.push(event);
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));

    // A real event for this season+week replaces any "coming up" schedule
    // teaser for the same slot — best-effort, never blocks the event save.
    if (event.season && event.week) {
      try {
        const scheduleRaw = await kvGet(accountId, apiToken, 'admin:schedule');
        const scheduleEntries = scheduleRaw ? JSON.parse(scheduleRaw) : [];
        const id = `${event.season}-w${event.week}`;
        if (scheduleEntries.some(e => e.id === id)) {
          await kvPut(accountId, apiToken, 'admin:schedule', JSON.stringify(scheduleEntries.filter(e => e.id !== id)));
        }
      } catch { /* non-critical cleanup */ }
    }

    return Response.json({ ok: true, event }, { headers: CORS });
  }

  if (action === 'update-event') {
    const { event } = body;
    if (!event || !event.id) return Response.json({ error: 'Missing event data' }, { status: 400, headers: CORS });
    if (Array.isArray(event.rounds)) event.rounds = await resolveCourseIds(event.rounds);
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
      // Also log a long-term trend point per player — best-effort, never
      // blocks activation itself if this secondary write has a problem.
      try {
        const historyRaw = await kvGet(accountId, apiToken, 'players:mashcap-history');
        const history = historyRaw ? JSON.parse(historyRaw) : {};
        recordMashCapPoint(history, events[idx], JSON.parse(handicapsRaw));
        sortMashCapHistory(history);
        await kvPut(accountId, apiToken, 'players:mashcap-history', JSON.stringify(history));
      } catch { /* trend history is supplementary */ }
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

  // One-time migration: reconstructs players:mashcap-history from every
  // already-existing ${eventId}:handicaps snapshot (activation has been
  // taking these since before this trend even existed) — so turning this
  // feature on doesn't mean starting from a blank chart. Safe to re-run any
  // time (recordMashCapPoint upserts by eventId), e.g. after an old event
  // gets a corrected handicap snapshot for some reason.
  if (action === 'backfill-mashcap-history') {
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    // 'upcoming' events have never been activated, so they have no snapshot
    // to pull from — anything else (active or completed) might.
    const eligible = events.filter(e => e.status === 'active' || e.status === 'completed');

    const snapshots = await Promise.all(eligible.map(e => kvGet(accountId, apiToken, `${e.id}:handicaps`)));

    const historyRaw = await kvGet(accountId, apiToken, 'players:mashcap-history');
    const history = historyRaw ? JSON.parse(historyRaw) : {};

    let snapshotsFound = 0;
    eligible.forEach((event, i) => {
      const snapRaw = snapshots[i];
      if (!snapRaw) return;
      let snap;
      try { snap = JSON.parse(snapRaw); } catch { return; }
      recordMashCapPoint(history, event, snap);
      snapshotsFound++;
    });

    sortMashCapHistory(history);
    await kvPut(accountId, apiToken, 'players:mashcap-history', JSON.stringify(history));

    return Response.json({
      ok: true,
      eventsScanned: eligible.length,
      snapshotsFound,
      playersRecorded: Object.keys(history).length,
    }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
