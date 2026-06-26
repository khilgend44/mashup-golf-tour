// Computes the official MashUp handicap for players from the SGT
// player-hcp-rounds API.
//   Handicap = average of the best floor(N * 0.40) scoring differentials,
//   duplicates kept, no minimum round count.
// Route: /admin/api/inspect-rounds
//   ?players=a,b,c   → scope to those players
//   (no players)     → whole roster from KV (players:roster)
//   ?raw=1           → return the raw SGT rounds instead of the computed table
// Protected by Cloudflare Access.
import { CORS, kvGet, requireAccess } from './_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const key = env.player_api_key;
  if (!key) return Response.json({ error: 'player_api_key not configured' }, { status: 500, headers: CORS });

  const url = new URL(request.url);
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
