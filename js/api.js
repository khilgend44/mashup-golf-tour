// Scorecards/CTP/CTP-video are read live from Cloudflare KV while an event
// is active (functions/api/live-data.js — written directly by
// fetch-scorecards.yml, not by a git commit, since 2026-11), falling back
// to the git-committed data/{type}/{id}.json file on a miss. A historical
// event never gets a live-data key at all (it's cleared the moment the
// workflow finalizes it back to a static file on completion), so this
// falls straight through to the static fetch for every old event — same
// request shape, same result, as before live-data.js existed.
//
// cache: 'no-store' on both legs, not just Cloudflare's own Cache-Control
// header: mobile Safari/WebKit has a long history of caching more
// aggressively than the header asks for — confirmed 2026-09, a score
// stayed missing on mobile Safari well after it showed up on desktop and
// mobile Chrome for the same URL. The static leg also still cache-busts
// with a query param for the same reason.
//
// Absolute paths throughout, not relative — this module is imported from
// pages at different depths (site root, but also /admin/*), and a relative
// `data/...` resolves against the *calling page's* URL, not the site root.
// Confirmed 2026-09: `/admin/events.html` importing this got
// `/admin/data/scorecards/...` (real path is `/data/scorecards/...`),
// 404ing silently every time.
async function fetchLiveOrStatic(type, tournamentId, staticPath, emptyValue) {
  try {
    const liveRes = await fetch(`/api/live-data?type=${type}&tid=${tournamentId}`, { cache: 'no-store' });
    if (liveRes.ok) {
      const text = await liveRes.text();
      if (text.trim()) return JSON.parse(text);
    }
  } catch { /* fall through to the static file below */ }

  try {
    const res = await fetch(`${staticPath}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return emptyValue;
    const text = await res.text();
    if (!text.trim()) return emptyValue;
    return JSON.parse(text);
  } catch {
    return emptyValue;
  }
}

export async function fetchScorecards(tournamentId) {
  return fetchLiveOrStatic('scorecards', tournamentId, `/data/scorecards/${tournamentId}.json`, []);
}

// Closest-to-pin (CTP) standings, refreshed by the same GitHub Action/cadence
// as scorecards. No official SGT endpoint for this exists — the fetch job
// scrapes SGT's own CTP tab and writes the parsed result here, so this can
// come back empty (e.g. the format has no CTP holes, or SGT's markup
// changed and broke the scraper) — always treat an empty/missing result as
// "nothing to show" rather than an error.
export async function fetchCtp(tournamentId) {
  return fetchLiveOrStatic('ctp', tournamentId, `/data/ctp/${tournamentId}.json`, { rounds: [] });
}

// CTP video deep links for the live "Closest to the Pin" hole cards —
// previously a one-off inline fetch in event.html instead of a shared
// function here; pulled in alongside fetchScorecards/fetchCtp so it gets
// the same live-first-then-static treatment without duplicating it.
export async function fetchCtpVideo(tournamentId) {
  return fetchLiveOrStatic('ctp-video', tournamentId, `/data/ctp-video/${tournamentId}.json`, []);
}

// Resolves the single cross-round CTP leader per hole from raw fetchCtp()
// data — the prize pays the closest shot to the pin across ALL rounds, not
// per round, but SGT's own data comes back one round-card at a time. An ace
// always wins outright; otherwise lowest distance. Shared by event.html's
// live CTP display (which marks this entry on the card) and
// admin/events.html's event-completion CTP form (which pre-fills suggested
// winners from it) — one source of truth so they can never disagree about
// who's actually leading a hole.
export function resolveCtpLeaders(ctpLive) {
  const rounds = (ctpLive?.rounds || []).filter(r => r.holes?.some(h => h.leaders?.length));
  const holeLeader = new Map(); // hole number -> { hole, round, player, ace, distance_ft }
  for (const r of rounds) {
    for (const h of (r.holes || [])) {
      const top = h.leaders?.[0]; // each hole's leaders are already sorted closest-first
      if (!top) continue;
      const curr = holeLeader.get(h.hole);
      const topBeats = !curr
        || (top.ace && !curr.ace)
        || (top.ace === curr.ace && top.distance_ft < curr.distance_ft);
      if (topBeats) holeLeader.set(h.hole, { hole: h.hole, round: r.round, player: top.player, ace: top.ace, distance_ft: top.distance_ft });
    }
  }
  return [...holeLeader.values()].sort((a, b) => a.hole - b.hole);
}

export async function loadSeasons() {
  // Absolute paths throughout this file — see the note on fetchScorecards
  // above. Not yet imported from a nested page like /admin/*, but the next
  // thing that does would hit the exact same silent-404 bug if these stayed
  // relative.
  const [staticRes, kvRes] = await Promise.allSettled([
    fetch('/data/seasons.json'),
    fetch('/api/seasons'),
  ]);
  const staticSeasons = staticRes.status === 'fulfilled' && staticRes.value.ok
    ? await staticRes.value.json() : [];
  const kvSeasons = kvRes.status === 'fulfilled' && kvRes.value.ok
    ? await kvRes.value.json() : [];
  const map = new Map(staticSeasons.map(s => [s.id, s]));
  for (const s of kvSeasons) map.set(s.id, s);
  return [...map.values()];
}

// ── Season status ─────────────────────────────────────────────────────────────
// A season's `status` is one of:
//   'upcoming'  — announced / taking registration, no events yet. Never "the current season".
//   'active'    — the live season (the one the public site features).
//   'completed' — archived.
// loadSeasons() returns static + KV seasons in source order (not by number), so pages must NOT use
// `seasons.find(s => s.status === 'active')` directly — with two actives it silently returns whichever is
// listed first. Use liveSeason() instead.

// "Season 11" / "season-11" → 11. Season numbers are only an ordering key for the *list*; they are not
// chronological for every season (Season 8 was back-filled after Season 9), so never use them to decide
// which season is current — use status.
export function seasonNumber(s) {
  const m = /(\d+)\s*$/.exec((s && (s.id || s.name)) || '');
  return m ? parseInt(m[1], 10) : -1;
}

// Newest first (Season 11, 10, 9, 8…) for display lists and pickers.
export function sortSeasonsNewestFirst(seasons) {
  return [...seasons].sort((a, b) => seasonNumber(b) - seasonNumber(a));
}

// The one season the public site treats as current: the active season; if (mis)configured with several,
// the lowest-numbered one (the long-running season, not one that was flipped active early); otherwise the
// first non-upcoming season; otherwise whatever there is.
export function liveSeason(seasons) {
  if (!Array.isArray(seasons) || !seasons.length) return null;
  const active = seasons.filter(s => s.status === 'active').sort((a, b) => seasonNumber(a) - seasonNumber(b));
  return active[0] || seasons.find(s => s.status !== 'upcoming') || seasons[0];
}

// Display label for a season's status.
export function seasonStatusLabel(s) {
  return s && s.status === 'upcoming' ? 'Upcoming' : s && s.status === 'active' ? 'Active' : 'Completed';
}

export async function loadEvents() {
  const [staticRes, kvRes, ovRes] = await Promise.allSettled([
    fetch('/data/events.json'),
    fetch('/api/events-admin?type=events'),
    fetch('/data/overrides.json'),
  ]);
  const staticEvents = staticRes.status === 'fulfilled' && staticRes.value.ok
    ? await staticRes.value.json() : [];
  const kvEvents = kvRes.status === 'fulfilled' && kvRes.value.ok
    ? await kvRes.value.json() : [];
  // KV events take precedence over static if same ID
  const map = new Map(staticEvents.map(e => [e.id, e]));
  for (const e of kvEvents) map.set(e.id, e);

  // Manual overrides (DQ / score corrections / banner) keyed by event id.
  // Stored in the repo so they survive the scorecard refresh and can be edited
  // without touching KV. Merged onto the event for the scoring engine to apply.
  const overrides = ovRes.status === 'fulfilled' && ovRes.value.ok
    ? await ovRes.value.json().catch(() => ({})) : {};
  for (const [id, ov] of Object.entries(overrides)) {
    const e = map.get(id);
    if (e) Object.assign(e, ov);
  }
  return [...map.values()];
}

export async function loadFormats() {
  const [staticRes, customRes] = await Promise.allSettled([
    fetch('/data/formats.json'),
    fetch('/api/events-admin?type=formats'),
  ]);
  const staticFormats = staticRes.status === 'fulfilled' && staticRes.value.ok
    ? await staticRes.value.json() : {};
  const customFormats = customRes.status === 'fulfilled' && customRes.value.ok
    ? await customRes.value.json() : {};
  return { ...staticFormats, ...customFormats };
}
