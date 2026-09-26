// Admin-only week-over-week MashCAP comparison. Route: GET /admin/api/handicap-changes?eventId=X
//
// Every time an event is activated (admin/events.html's "Activate Event"),
// events.js snapshots the then-current players:handicaps blob verbatim under
// `${eventId}:handicaps` — a locked-in record of what each player's MashCAP
// was for that event. That snapshot was write-only until now (nothing ever
// read it back). This endpoint reads three of those snapshots — the
// requested event, the same season's previous week, and the same season's
// week 1 — and diffs them per player.
import { CORS, kvGet, requireAccess } from './_lib.js';

async function loadHandicapSnapshot(accountId, apiToken, eventId) {
  if (!eventId) return null;
  const raw = await kvGet(accountId, apiToken, `${eventId}:handicaps`);
  return raw ? JSON.parse(raw) : null;
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

  const eventId = new URL(request.url).searchParams.get('eventId');
  if (!eventId) return Response.json({ error: 'eventId required' }, { status: 400, headers: CORS });

  const eventsRaw = await kvGet(accountId, apiToken, 'admin:events');
  const events = eventsRaw ? JSON.parse(eventsRaw) : [];
  const event = events.find(e => e.id === eventId);
  if (!event) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });

  // Same-season siblings, needed to find "previous week" and "week 1".
  const seasonEvents = events.filter(e => e.season === event.season && e.week != null);
  const prevWeekEvent = event.week > 1
    ? seasonEvents.filter(e => e.week === event.week - 1)[0] || null
    : null;
  const week1Event = event.week > 1
    ? seasonEvents.filter(e => e.week === 1)[0] || null
    : null;

  const [currentSnap, prevWeekSnap, week1Snap] = await Promise.all([
    loadHandicapSnapshot(accountId, apiToken, event.id),
    loadHandicapSnapshot(accountId, apiToken, prevWeekEvent?.id),
    loadHandicapSnapshot(accountId, apiToken, week1Event?.id),
  ]);

  if (!currentSnap) {
    return Response.json({
      error: `No handicap snapshot for ${event.id} — it hasn't been Activated yet (that's the step that locks one in).`,
    }, { status: 404, headers: CORS });
  }

  // Union of every player name seen in any of the three snapshots — a
  // player who just joined won't be in earlier snapshots, and one who's
  // since left the roster still deserves to show their last known change.
  const names = new Set([
    ...Object.keys(currentSnap),
    ...Object.keys(prevWeekSnap || {}),
    ...Object.keys(week1Snap || {}),
  ]);

  const players = [...names].map(key => {
    const cur = currentSnap[key]?.mashCap ?? null;
    const prev = prevWeekSnap?.[key]?.mashCap ?? null;
    const wk1 = week1Snap?.[key]?.mashCap ?? null;
    return {
      name: key,
      current: cur,
      prevWeek: prev,
      week1: wk1,
      deltaPrevWeek: (cur != null && prev != null) ? +(cur - prev).toFixed(1) : null,
      deltaWeek1: (cur != null && wk1 != null) ? +(cur - wk1).toFixed(1) : null,
    };
  }).sort((a, b) => {
    // Biggest absolute week-over-week mover first; players with no
    // comparison data (e.g. brand new this week) sink to the bottom.
    const aAbs = a.deltaPrevWeek != null ? Math.abs(a.deltaPrevWeek) : -1;
    const bAbs = b.deltaPrevWeek != null ? Math.abs(b.deltaPrevWeek) : -1;
    return bAbs - aAbs;
  });

  return Response.json({
    event: { id: event.id, name: event.name, season: event.season, week: event.week },
    prevWeekEvent: prevWeekEvent ? { id: prevWeekEvent.id, name: prevWeekEvent.name, week: prevWeekEvent.week, hasSnapshot: !!prevWeekSnap } : null,
    week1Event: week1Event ? { id: week1Event.id, name: week1Event.name, week: week1Event.week, hasSnapshot: !!week1Snap } : null,
    players,
  }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}
