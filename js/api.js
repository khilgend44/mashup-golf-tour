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
  const res = await fetch('data/events.json');
  return res.json();
}

export async function loadFormats() {
  const res = await fetch('data/formats.json');
  return res.json();
}
