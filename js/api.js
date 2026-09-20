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
    const res = await fetch(`data/scorecards/${tournamentId}.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.trim()) return [];
    return JSON.parse(text);
  } catch {
    return [];
  }
}

export async function loadSeasons() {
  const [staticRes, kvRes] = await Promise.allSettled([
    fetch('data/seasons.json'),
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
    fetch('data/events.json'),
    fetch('/api/events-admin?type=events'),
    fetch('data/overrides.json'),
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
    fetch('data/formats.json'),
    fetch('/api/events-admin?type=formats'),
  ]);
  const staticFormats = staticRes.status === 'fulfilled' && staticRes.value.ok
    ? await staticRes.value.json() : {};
  const customFormats = customRes.status === 'fulfilled' && customRes.value.ok
    ? await customRes.value.json() : {};
  return { ...staticFormats, ...customFormats };
}
