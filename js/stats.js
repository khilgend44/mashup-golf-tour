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

// Recent form: the player's last `n` rounds vs their own baseline (the mean of
// their earlier rounds). Negative delta = playing better than usual lately
// ("hot"). NB: we compare to the player's *average*, not their MashCAP —
// MashCAP is a best-40% metric, so almost any stretch looks worse than it,
// which would make everyone read "cold."
export function recentForm(rounds, n = 5) {
  if (!Array.isArray(rounds) || rounds.length < 3) return null;
  const desc = [...rounds].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const mean = arr => arr.reduce((s, r) => s + r.differential, 0) / arr.length;
  const recent = desc.slice(0, n);
  const prior = desc.slice(n);
  const recentAvg = mean(recent);
  const base = prior.length >= 3 ? mean(prior) : mean(desc); // baseline = earlier form, or all if too few
  const delta = Math.round((recentAvg - base) * 100) / 100;
  const label = delta <= -1 ? 'hot' : delta >= 1 ? 'cold' : 'steady';
  return { count: recent.length, avg: Math.round(recentAvg * 100) / 100, base: Math.round(base * 100) / 100, delta, label };
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

    // Participation = anyone with a completed scorecard actually played this
    // event. Named-payout events (e.g. Season 9) only list money winners, so
    // counting "events played" from payouts alone undercounts everyone who
    // played without placing. Load scorecards once and reuse them below.
    let scorecards = null;
    if (e.tournamentId != null) {
      try { scorecards = await fetchScorecards(e.tournamentId); } catch { /* none cached */ }
    }
    if (scorecards) {
      for (const c of scorecards) {
        if (c && c.status === 'Completed' && c.player_name) ensure(c.player_name).events.add(e.id);
      }
    }

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
      if (fmt && scorecards) {
        try {
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

// ── Individual scoring rounds (from raw event scorecards) ─────────────────────
// Scans each completed event's cached scorecards and emits one record per
// completed player round: gross/net totals, to-par, and birdie/eagle counts.
// Powers the Scoring records (lowest round, most birdies, …).
// NB: assumes each player has their own ball (true for all current formats).
// Single-ball formats (scramble/alt-shot) would duplicate the team score across
// partners — exclude those events if/when they exist.
export async function scanScorecardRounds(events) {
  const out = [];
  for (const e of events) {
    if (e.tournamentId == null) continue;
    let cards;
    try { cards = await fetchScorecards(e.tournamentId); } catch { continue; }
    for (const c of cards) {
      if (!c || c.status !== 'Completed') continue;
      const totalGross = Number(c.total_gross);
      if (!totalGross) continue; // incomplete / blank card
      const totalNet = Number(c.total_net) || null;
      let birdies = 0, eagles = 0;
      for (let h = 1; h <= 18; h++) {
        const g = Number(c[`hole${h}_gross`]);
        const par = Number(c[`h${h}_Par`]);
        if (!g || !par) continue;
        const d = g - par;
        if (d <= -2) eagles++;
        else if (d === -1) birdies++;
      }
      out.push({
        player: c.player_name,
        event: e.name, week: e.week, season: e.season, eventId: e.id,
        totalGross,
        totalNet,
        toParGross: c.toPar_gross != null ? Number(c.toPar_gross) : null,
        birdies, eagles,
      });
    }
  }
  return out;
}

// Convenience: pull a single player's record (case-insensitive) from a stats map.
export function playerRecord(statsMap, name) {
  const rec = statsMap[String(name).toLowerCase()];
  if (!rec) return { name, earnings: 0, ctpEarnings: 0, wins: 0, podiums: 0, events: new Set(), finishes: [] };
  return rec;
}
