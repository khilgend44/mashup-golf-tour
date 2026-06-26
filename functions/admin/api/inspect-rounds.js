// Computes the official MashUp handicap for players from the SGT
// player-hcp-rounds API.
//   Handicap = average of the best floor(N * 0.40) scoring differentials,
//   duplicates kept, no minimum round count.
// Route: /admin/api/inspect-rounds
//   ?players=a,b,c   → scope to those players
//   (no players)     → whole roster from KV (players:roster)
//   ?raw=1           → return the raw SGT rounds instead of the computed table
// Protected by Cloudflare Access.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

// Realistic sample (boiler_kh's actual 42 rounds) for demoing the public
// counting-events page before a real refresh has stored rounds. 42 rounds →
// floor(16.8)=16 counting → MashCAP -1.06.
const SAMPLE_ROUNDS = [
  { date: '2026-03-07', differential: -4.9, tour: 'MSH' }, { date: '2026-04-13', differential: -3.5, tour: 'MSH' },
  { date: '2026-02-09', differential: -2.3, tour: 'PRO' }, { date: '2026-05-17', differential: -1.3, tour: 'PRO' },
  { date: '2026-06-08', differential: -1.3, tour: 'PRO' }, { date: '2026-04-05', differential: -1.3, tour: 'MSH' },
  { date: '2026-01-19', differential: -0.9, tour: 'MSH' }, { date: '2025-12-29', differential: -0.8, tour: 'PRO' },
  { date: '2026-01-12', differential: -0.8, tour: 'SGT' }, { date: '2026-01-18', differential: -0.5, tour: 'SGT' },
  { date: '2026-04-26', differential: -0.2, tour: 'PRO' }, { date: '2026-03-15', differential: 0.1, tour: 'MSH' },
  { date: '2026-04-21', differential: 0.1, tour: 'MSH' }, { date: '2026-03-23', differential: 0.1, tour: 'MSH' },
  { date: '2026-05-11', differential: 0.1, tour: 'PRO' }, { date: '2026-02-01', differential: 0.4, tour: 'SGT' },
  { date: '2026-04-20', differential: 0.6, tour: 'PRO' }, { date: '2026-03-07', differential: 0.7, tour: 'MSH' },
  { date: '2026-01-12', differential: 0.8, tour: 'SGT' }, { date: '2025-12-29', differential: 0.9, tour: 'PRO' },
  { date: '2026-05-17', differential: 0.9, tour: 'PRO' }, { date: '2026-01-04', differential: 1.2, tour: 'MSH' },
  { date: '2026-05-24', differential: 1.2, tour: 'PRO' }, { date: '2026-01-25', differential: 1.3, tour: 'MSH' },
  { date: '2026-06-15', differential: 1.4, tour: 'PRO' }, { date: '2026-03-02', differential: 1.5, tour: 'SGT' },
  { date: '2026-01-12', differential: 1.7, tour: 'PRO' }, { date: '2026-01-18', differential: 2.3, tour: 'SGT' },
  { date: '2026-04-13', differential: 2.4, tour: 'PRO' }, { date: '2026-05-11', differential: 2.6, tour: 'SGT' },
  { date: '2026-02-22', differential: 3.3, tour: 'SGT' }, { date: '2026-03-30', differential: 3.3, tour: 'SGT' },
  { date: '2026-02-22', differential: 3.3, tour: 'SGT' }, { date: '2026-02-09', differential: 4, tour: 'PRO' },
  { date: '2026-05-11', differential: 4.2, tour: 'SGT' }, { date: '2026-03-30', differential: 4.9, tour: 'SGT' },
  { date: '2026-05-04', differential: 4.9, tour: 'PRO' }, { date: '2026-03-16', differential: 5.7, tour: 'SGT' },
  { date: '2026-06-22', differential: 5.8, tour: 'SGT' }, { date: '2026-06-01', differential: 6, tour: 'PRO' },
  { date: '2026-06-01', differential: 6, tour: 'PRO' }, { date: '2026-04-26', differential: 8, tour: 'PRO' },
];

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const url = new URL(request.url);

  // Debug seed: write a MashCAP straight into KV for one player, for display
  // illustration only (no SGT call, no refresh). Example:
  //   ?seedMashCap=boiler_kh&value=-1.06&rounds=42&counting=16
  const seedPlayer = url.searchParams.get('seedMashCap');
  if (seedPlayer) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken  = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return Response.json({ error: 'Missing KV credentials' }, { status: 500, headers: CORS });
    const value = parseFloat(url.searchParams.get('value'));
    if (Number.isNaN(value)) return Response.json({ error: 'value (number) required' }, { status: 400, headers: CORS });
    const rounds   = parseInt(url.searchParams.get('rounds')   || '', 10);
    const counting = parseInt(url.searchParams.get('counting') || '', 10);
    const raw = await kvGet(accountId, apiToken, 'players:handicaps');
    const map = raw ? JSON.parse(raw) : {};
    const k = seedPlayer.toLowerCase();
    const entry = map[k] || {};
    entry.mashCap = value;
    if (!Number.isNaN(rounds))   entry.mashCapRounds   = rounds;
    if (!Number.isNaN(counting)) entry.mashCapCounting = counting;
    map[k] = entry;
    await kvPut(accountId, apiToken, 'players:handicaps', JSON.stringify(map));
    return Response.json({ ok: true, seeded: k, entry }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  // Debug seed: write the SAMPLE_ROUNDS array to players:rounds for one player
  // so the public counting-events page can be demoed before a real refresh.
  //   ?seedRounds=boiler_kh
  const seedRoundsPlayer = url.searchParams.get('seedRounds');
  if (seedRoundsPlayer) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken  = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return Response.json({ error: 'Missing KV credentials' }, { status: 500, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'players:rounds');
    const map = raw ? JSON.parse(raw) : {};
    const k = seedRoundsPlayer.toLowerCase();
    map[k] = SAMPLE_ROUNDS;
    await kvPut(accountId, apiToken, 'players:rounds', JSON.stringify(map));
    return Response.json({ ok: true, seededRounds: k, count: SAMPLE_ROUNDS.length }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  const key = env.player_api_key;
  if (!key) return Response.json({ error: 'player_api_key not configured' }, { status: 500, headers: CORS });
  const scoped = (url.searchParams.get('players') || '').split(',').map(s => s.trim()).filter(Boolean);

  // Determine the player list: explicit ?players= or the full roster from KV.
  let players = scoped;
  if (players.length === 0) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken  = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return Response.json({ error: 'Missing KV credentials' }, { status: 500, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'players:roster');
    players = raw ? JSON.parse(raw) : [];
  }
  if (players.length === 0) return Response.json({ error: 'No players to look up' }, { status: 400, headers: CORS });

  // One comma-separated request for the whole list.
  // Encode each name individually but keep commas literal as the list delimiter
  // (matching the proven player-check refresh, which joins with a raw comma).
  const playerParam = players.map(p => encodeURIComponent(p)).join(',');
  const sgtUrl = `https://simulatorgolftour.com/sgt-api/mashup/player-hcp-rounds?key=${key}&players=${playerParam}`;
  // Bypass any Cloudflare-side caching so a stale response can only originate at SGT.
  const res = await fetch(sgtUrl, { cf: { cacheTtl: 0, cacheEverything: false }, headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) return Response.json({ error: `SGT API error: ${res.status}` }, { status: 502, headers: CORS });

  let rounds;
  try { rounds = await res.json(); } catch { return Response.json({ error: 'SGT did not return JSON' }, { status: 502, headers: CORS }); }
  if (!Array.isArray(rounds)) rounds = [];

  if (url.searchParams.get('raw') === '1') {
    return Response.json(rounds, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  // Group differentials by player (case-insensitive key, keep first-seen display name).
  const byPlayer = {};
  for (const r of rounds) {
    if (!r || r.player == null || typeof r.differential !== 'number') continue;
    const k = String(r.player).toLowerCase();
    if (!byPlayer[k]) byPlayer[k] = { name: r.player, diffs: [] };
    byPlayer[k].diffs.push(r.differential);
  }

  const round2 = n => Math.round(n * 100) / 100;
  const table = Object.values(byPlayer).map(p => {
    const n = p.diffs.length;
    const counting = Math.floor(n * 0.40);                 // round DOWN
    const best = [...p.diffs].sort((a, b) => a - b).slice(0, counting);
    const handicap = counting > 0 ? round2(best.reduce((a, b) => a + b, 0) / counting) : null;
    return { player: p.name, rounds: n, counting, handicap, bestDifferentials: best };
  }).sort((a, b) => {
    if (a.handicap == null) return 1;
    if (b.handicap == null) return -1;
    return a.handicap - b.handicap;                        // lowest (best) first
  });

  // Any requested players SGT returned nothing for.
  const got = new Set(Object.keys(byPlayer));
  const missing = players.filter(p => !got.has(String(p).toLowerCase()));

  return Response.json(
    { generatedAt: new Date().toISOString(), playerCount: table.length, missing, players: table },
    { headers: { ...CORS, 'Cache-Control': 'no-store' } }
  );
}
