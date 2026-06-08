// Scorecards are cached locally in data/scorecards/{id}.json at event creation time.
// This avoids CORS issues and keeps the API key off the client.

export async function fetchScorecards(tournamentId) {
  const res = await fetch(`data/scorecards/${tournamentId}.json`);
  if (!res.ok) throw new Error(`Scorecard data not found for tournament ${tournamentId}. Make sure data/scorecards/${tournamentId}.json exists.`);
  const text = await res.text();
  if (!text.trim()) return [];
  return JSON.parse(text);
}

export async function loadSeasons() {
  const res = await fetch('data/seasons.json');
  return res.json();
}

export async function loadEvents() {
  const [staticRes, kvRes] = await Promise.allSettled([
    fetch('data/events.json'),
    fetch('/api/events-admin?type=events'),
  ]);
  const staticEvents = staticRes.status === 'fulfilled' && staticRes.value.ok
    ? await staticRes.value.json() : [];
  const kvEvents = kvRes.status === 'fulfilled' && kvRes.value.ok
    ? await kvRes.value.json() : [];
  // KV events take precedence over static if same ID
  const map = new Map(staticEvents.map(e => [e.id, e]));
  for (const e of kvEvents) map.set(e.id, e);
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
