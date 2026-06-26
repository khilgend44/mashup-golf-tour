// Protected admin WRITE endpoint for the player roster + handicap refresh.
// Route: /admin/api/players.  Reads remain public at /api/players.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

const SGT_API_BASE   = 'https://simulatorgolftour.com/sgt-api/mashup/player-check';
const SGT_ROUNDS_API = 'https://simulatorgolftour.com/sgt-api/mashup/player-hcp-rounds';

// Official MashUp handicap: average of the best floor(N * 0.40) scoring
// differentials. Duplicates kept, no minimum round count (per league rule).
function computeMashupCap(diffs) {
  const n = diffs.length;
  const counting = Math.floor(n * 0.40);
  if (counting <= 0) return null;
  const best = [...diffs].sort((a, b) => a - b).slice(0, counting);
  const cap = best.reduce((a, b) => a + b, 0) / counting;
  return { cap: Math.round(cap * 100) / 100, rounds: n, counting };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Protected read: the player → Discord ID map (kept out of the public /api/players).
export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });
  const raw = await kvGet(accountId, apiToken, 'players:discord');
  return Response.json({ discord: raw ? JSON.parse(raw) : {} }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  const sgtKey    = env.player_api_key;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const { action } = body;

  if (action === 'onboard') {
    const { players } = body;
    if (!Array.isArray(players) || players.length === 0)
      return Response.json({ error: 'No players provided' }, { status: 400, headers: CORS });
    const cleaned = [...new Set(players.map(p => p.trim()).filter(Boolean))];
    await kvPut(accountId, apiToken, 'players:roster', JSON.stringify(cleaned));
    return Response.json({ ok: true, count: cleaned.length, roster: cleaned }, { headers: CORS });
  }

  if (action === 'set-discord') {
    const { player, discordId } = body;
    if (!player) return Response.json({ error: 'No player provided' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'players:discord');
    const map = raw ? JSON.parse(raw) : {};
    const key = String(player).toLowerCase();
    const id  = String(discordId || '').trim();
    if (id) map[key] = id; else delete map[key];
    await kvPut(accountId, apiToken, 'players:discord', JSON.stringify(map));
    return Response.json({ ok: true, discord: map }, { headers: CORS });
  }

  if (action === 'add') {
    const { player } = body;
    if (!player) return Response.json({ error: 'No player provided' }, { status: 400, headers: CORS });
    const rosterRaw = await kvGet(accountId, apiToken, 'players:roster');
    const roster = rosterRaw ? JSON.parse(rosterRaw) : [];
    const trimmed = player.trim();
    if (!roster.find(p => p.toLowerCase() === trimmed.toLowerCase())) {
      roster.push(trimmed);
      await kvPut(accountId, apiToken, 'players:roster', JSON.stringify(roster));
    }
    return Response.json({ ok: true, roster }, { headers: CORS });
  }

  if (action === 'remove') {
    const { player } = body;
    if (!player) return Response.json({ error: 'No player provided' }, { status: 400, headers: CORS });
    const rosterRaw = await kvGet(accountId, apiToken, 'players:roster');
    const roster = rosterRaw ? JSON.parse(rosterRaw) : [];
    const updated = roster.filter(p => p.toLowerCase() !== player.toLowerCase());
    await kvPut(accountId, apiToken, 'players:roster', JSON.stringify(updated));
    return Response.json({ ok: true, roster: updated }, { headers: CORS });
  }

  if (action === 'refresh') {
    if (!sgtKey) return Response.json({ error: 'player_api_key not configured' }, { status: 500, headers: CORS });

    const scopedPlayers = Array.isArray(body.players) && body.players.length ? body.players : null;

    const rosterRaw = await kvGet(accountId, apiToken, 'players:roster');
    const fullRoster = rosterRaw ? JSON.parse(rosterRaw) : [];
    const playersToFetch = scopedPlayers || fullRoster;
    if (playersToFetch.length === 0) return Response.json({ error: 'No players to refresh' }, { status: 400, headers: CORS });

    const url = `${SGT_API_BASE}?key=${sgtKey}&players=${playersToFetch.join(',')}`;
    const sgtRes = await fetch(url);
    if (!sgtRes.ok) return Response.json({ error: `SGT API error: ${sgtRes.status}` }, { status: 502, headers: CORS });

    const data = await sgtRes.json();
    const fetched = {};
    for (const p of data) {
      fetched[p.user_name.toLowerCase()] = {
        rawCap: p.rawCap,
        comboCap: p.comboCap,
        numEvents: p.NumEvents,
        connector: p.Connector_Used || '',
        minComboCap: p.minComboCap,
        comboRoundsCount: p.comboRoundsCount,
      };
    }

    // Also pull per-round differentials and compute the MashUp handicap, merging
    // it onto each player's entry. Supplementary — failures must not break the
    // core handicap refresh. Note: SGT caps player-hcp-rounds at ~1 response per
    // key per 24h, so this may only populate fully on the first call of a window.
    try {
      const roundsUrl = `${SGT_ROUNDS_API}?key=${sgtKey}&players=${playersToFetch.map(p => encodeURIComponent(p)).join(',')}`;
      const rRes = await fetch(roundsUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
      if (rRes.ok) {
        const rounds = await rRes.json();
        if (Array.isArray(rounds)) {
          const diffsByPlayer = {};
          for (const r of rounds) {
            if (!r || r.player == null || typeof r.differential !== 'number') continue;
            const k = String(r.player).toLowerCase();
            (diffsByPlayer[k] = diffsByPlayer[k] || []).push(r.differential);
          }
          for (const [k, diffs] of Object.entries(diffsByPlayer)) {
            const m = computeMashupCap(diffs);
            if (m && fetched[k]) {
              fetched[k].mashupCap      = m.cap;
              fetched[k].mashupRounds   = m.rounds;
              fetched[k].mashupCounting = m.counting;
            }
          }
        }
      }
    } catch { /* MashUp cap is supplementary; ignore failures */ }

    const now = new Date().toISOString();

    let finalHandicaps;
    if (scopedPlayers) {
      const existingRaw = await kvGet(accountId, apiToken, 'players:handicaps');
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      finalHandicaps = { ...existing, ...fetched };
    } else {
      finalHandicaps = fetched;
    }

    await Promise.all([
      kvPut(accountId, apiToken, 'players:handicaps', JSON.stringify(finalHandicaps)),
      kvPut(accountId, apiToken, 'players:last_refresh', now),
    ]);

    return Response.json({ ok: true, count: data.length, lastRefresh: now, handicaps: finalHandicaps }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
