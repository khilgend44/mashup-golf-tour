// Reusable player-stats engine. One source of truth for per-player money,
// wins, finishes (from the scoring engine) and MashCAP-from-rounds math.
// Consumed by player.html (profiles) and — going forward — Records / Superlatives.
import { fetchScorecards } from './api.js';
import { applyFormat, applyPayouts, resolveSidePots } from './scoring.js';

// SGT's COMBO log caps at the most-recent 48 rounds; mirror it when a stored
// comboRoundsCount isn't available. (Stored player rounds are already trimmed,
// so this mainly guards ad-hoc callers.)
export const COMBO_ROUND_CAP = 48;

const stripSub = name => name.replace(/\s*\(sub\)$/, '');

// ── MashCAP from a rounds array ───────────────────────────────────────────────
// rounds: [{ date, differential, tour }]. Trims to the most-recent `cap` rounds,
// then averages the best floor(N × 0.40) differentials. Matches computeMashCap
// on the server.
export function mashCapFromRounds(rounds, cap = COMBO_ROUND_CAP) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  const recent = [...rounds]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, cap);
  const n = recent.length;
  const counting = Math.floor(n * 0.40);
  if (counting <= 0) return null;
  const best = recent.map(r => r.differential).sort((a, b) => a - b).slice(0, counting);
  const avg = best.reduce((a, b) => a + b, 0) / counting;
  return { cap: Math.round(avg * 100) / 100, rounds: n, counting };
}

// Rolling MashCAP over time: the player's MashCAP after each round, oldest→newest.
// Returns [{ date, cap }] for plotting the trend line.
export function rollingMashCap(rounds, cap = COMBO_ROUND_CAP) {
  if (!Array.isArray(rounds) || !rounds.length) return [];
  const asc = [...rounds].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  for (let i = 0; i < asc.length; i++) {
    const m = mashCapFromRounds(asc.slice(0, i + 1), cap);
    if (m) out.push({ date: asc[i].date, cap: m.cap });
  }
  return out;
}

// Recent form: average of the last `n` differentials vs the player's MashCAP.
// Negative delta = playing better than their handicap ("hot").
export function recentForm(rounds, mashCap, n = 5) {
  if (!Array.isArray(rounds) || !rounds.length || mashCap == null) return null;
  const recent = [...rounds]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, n);
  if (!recent.length) return null;
  const avg = recent.reduce((a, b) => a + b.differential, 0) / recent.length;
  const delta = Math.round((avg - mashCap) * 100) / 100;
  const label = delta <= -1 ? 'hot' : delta >= 1 ? 'cold' : 'steady';
  return { count: recent.length, avg: Math.round(avg * 100) / 100, delta, label };
}

// ── Per-player season/career money + finishes (scoring-engine derived) ────────
// Mirrors season.html buildStandings, but keyed by player and capturing each
// finish so profiles can show wins, podiums, and an event-by-event timeline.
// Returns { [lowercaseName]: record }.
export async function buildPlayerStats(completedEvents, formats) {
  const players = {};
  const ensure = name => {
    const clean = stripSub(name);
    const key = clean.toLowerCase();
    if (!players[key]) players[key] = {
      name: clean, earnings: 0, ctpEarnings: 0, wins: 0, podiums: 0,
      events: new Set(), finishes: [],
    };
    return players[key];
  };

  for (const e of completedEvents) {
    const meta = { eventId: e.id, tournamentId: e.tournamentId, name: e.name, format: e.format, week: e.week, season: e.season, date: e.date };
    const hasNames = (e.payouts || []).some(p => p.player);

    if (hasNames) {
      for (const p of e.payouts) {
        if (!p.player) continue;
        const rec = ensure(p.player);
        rec.earnings += p.amount || 0;
        rec.events.add(e.id);
        if (p.place === 1) rec.wins++;
        if (p.place <= 3) rec.podiums++;
        rec.finishes.push({ ...meta, position: p.place, prize: p.amount || 0 });
      }
    } else {
      const fmt = formats[e.format];
      if (fmt && e.tournamentId != null) {
        try {
          const scorecards = await fetchScorecards(e.tournamentId);
          const results = applyFormat(scorecards, fmt, e);
          applyPayouts(results, e.payouts);
          const teamSize = parseInt(fmt.teamSize) || 1;
          for (const r of results) {
            const members = r.isTeam ? r.displayMembers : [r.player_name];
            if (!members || !members[0]) continue;
            const share = r.prize == null ? 0 : (r.isTeam ? r.prize / teamSize : r.prize);
            for (const m of members) {
              const rec = ensure(m);
              rec.events.add(e.id);
              rec.finishes.push({ ...meta, position: r.position, prize: share });
              if (share) rec.earnings += share;
              if (r.position === 1) rec.wins++;
              if (r.position <= 3) rec.podiums++;
            }
          }
          for (const sp of resolveSidePots(results, e, fmt)) {
            if (!sp.player) continue;
            const rec = ensure(sp.player);
            rec.earnings += sp.amount || 0;
            rec.events.add(e.id);
          }
        } catch { /* skip event if scoring fails */ }
      }
    }

    for (const c of (e.ctp || [])) {
      if (!c.player) continue;
      const rec = ensure(c.player);
      rec.ctpEarnings += c.amount || 0;
      rec.events.add(e.id);
    }
  }

  return players;
}

// Convenience: pull a single player's record (case-insensitive) from a stats map.
export function playerRecord(statsMap, name) {
  const rec = statsMap[String(name).toLowerCase()];
  if (!rec) return { name, earnings: 0, ctpEarnings: 0, wins: 0, podiums: 0, events: new Set(), finishes: [] };
  return rec;
}
