// Scorecards are cached locally in data/scorecards/{id}.json at event creation time.
// This avoids CORS issues and keeps the API key off the client.
// cache-bust: force a fresh Cloudflare response so the new no-cache header
// (see _headers) attaches to a genuine 200, not a stale revalidated 304.

export async function fetchScorecards(tournamentId) {
  try {
    // Cloudflare serves this with `Cache-Control: max-age=0, must-revalidate`,
    // which Chrome honors correctly (revalidates via ETag every time) but
    // mobile Safari/WebKit has a long history of caching more aggressively
    // than the header asks for — confirmed 2026-09, a score stayed missing
    // on mobile Safari well after it showed up on desktop and mobile Chrome
    // for the same URL. `cache: 'no-store'` plus a cache-busting query param
    // sidesteps relying on Safari to interpret the header correctly at all.
    // Absolute path, not relative — this module is imported from pages at
    // different depths (site root, but also /admin/*), and a relative
    // `data/...` resolves against the *calling page's* URL, not the site
    // root. Confirmed 2026-09: `/admin/events.html` importing this got
    // `/admin/data/scorecards/...` (real path is `/data/scorecards/...`),
    // 404ing silently every time.
    const res = await fetch(`/data/scorecards/${tournamentId}.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.trim()) return [];
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// Closest-to-pin (CTP) standings, refreshed by the same GitHub Action/cadence
// as scorecards. No official SGT endpoint for this exists — the fetch job
// scrapes SGT's own CTP tab and writes the parsed result here, so this can
// come back empty (e.g. the format has no CTP holes, or SGT's markup
// changed and broke the scraper) — always treat an empty/missing result as
// "nothing to show" rather than an error.
export async function fetchCtp(tournamentId) {
  try {
    // Absolute path — see the same note on fetchScorecards above. This was
    // the actual bug behind admin/events.html's CTP suggestions never
    // showing up: fetchCtp silently 404'd from that page's directory, so
    // resolveCtpLeaders always got an empty { rounds: [] } to work with.
    const res = await fetch(`/data/ctp/${tournamentId}.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { rounds: [] };
    const text = await res.text();
    if (!text.trim()) return { rounds: [] };
    return JSON.parse(text);
  } catch {
    return { rounds: [] };
  }
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
