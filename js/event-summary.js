// Event Summary — a post-event stat digest, computed live from scorecards
// (no pre-computed/stored data, same philosophy as recap.html/season.html:
// cheap enough to recompute on every page load, so there's nothing to keep
// in sync). Built for event-summary.html.
//
// Classification convention deliberately matches holeScoreClass() in
// scoring.js and scanScorecardRounds() in stats.js — eagle: diff<=-2,
// birdie: diff===-1 (exact, not "birdie or better" — same as records.html's
// "Most Birdies" record), par: 0, bogey: 1, double+: diff>=2. Keeping one
// bucket definition site-wide means these numbers agree with records.html
// and event.html's scorecard coloring instead of quietly drifting apart.
import { isCardComplete } from './scoring.js';

function classify(diff) {
  if (diff <= -2) return 'eagle';
  if (diff === -1) return 'birdie';
  if (diff === 0) return 'par';
  if (diff === 1) return 'bogey';
  return 'double';
}

// Per-hole diff array (score - par) for one card/basis, plus the per-hole
// classification bucket, needed by both event-wide tallies and
// player-level streak/superlative detection.
function holeDiffs(card, basis) {
  return Array.from({ length: 18 }, (_, i) => {
    const score = card[`hole${i + 1}_${basis}`];
    const par = card[`h${i + 1}_Par`];
    return (score == null || par == null) ? null : score - par;
  });
}

// Longest run of consecutive birdie-or-better holes (diff <= -1) in one
// round. Returns { length, startHole, endHole } (1-indexed), or null if the
// round has no birdie-or-better hole at all.
function longestStreak(diffs) {
  let best = null, curStart = null, curLen = 0;
  for (let i = 0; i < 18; i++) {
    const good = diffs[i] != null && diffs[i] <= -1;
    if (good) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (!best || curLen > best.length) best = { length: curLen, startHole: curStart + 1, endHole: i + 1 };
    } else {
      curLen = 0;
    }
  }
  return best;
}

function sumBucket(diffs, bucket) {
  return diffs.filter(d => d != null && classify(d) === bucket).length;
}

// ─── Event-wide gross/net tallies ──────────────────────────────────────────

function buildBasisEventStats(cards, basis) {
  const buckets = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0 };
  let scoreSum = 0, scoreCount = 0;
  const holeTotals = Array.from({ length: 18 }, () => ({ sum: 0, count: 0 }));
  const indexByHole = Array(18).fill(null); // SGT's stroke-index allocation, for comparing against actual difficulty

  for (const card of cards) {
    const diffs = holeDiffs(card, basis);
    for (let i = 0; i < 18; i++) {
      const d = diffs[i];
      if (indexByHole[i] == null && card[`h${i + 1}_index`] != null) indexByHole[i] = card[`h${i + 1}_index`];
      if (d == null) continue;
      buckets[classify(d)]++;
      holeTotals[i].sum += d;
      holeTotals[i].count++;
    }
    const total = card[`total_${basis}`];
    if (total != null) { scoreSum += total; scoreCount++; }
  }

  const holeAverages = holeTotals.map((h, i) => ({
    hole: i + 1,
    avgToPar: h.count ? h.sum / h.count : null,
    index: indexByHole[i],
  })).filter(h => h.avgToPar != null);

  const hardestHole = holeAverages.length ? holeAverages.reduce((a, b) => b.avgToPar > a.avgToPar ? b : a) : null;
  const easiestHole = holeAverages.length ? holeAverages.reduce((a, b) => b.avgToPar < a.avgToPar ? b : a) : null;

  return {
    avgScore: scoreCount ? scoreSum / scoreCount : null,
    roundsCounted: scoreCount,
    eagles: buckets.eagle,
    birdies: buckets.birdie,
    pars: buckets.par,
    bogeys: buckets.bogey,
    doubleOrWorse: buckets.double,
    hardestHole,
    easiestHole,
  };
}

// ─── Player-level superlatives ─────────────────────────────────────────────

function buildPlayerStats(cards, basis) {
  let bestRound = null;   // lowest total (best score)
  let mostBirdiesRound = null; // most birdie-or-better holes in one round
  let longest = null;     // longest streak overall
  let lowestFront = null, lowestBack = null;

  for (const card of cards) {
    const total = card[`total_${basis}`];
    const diffs = holeDiffs(card, basis);
    const toPar = card.h1_Par != null
      ? diffs.reduce((a, b) => a + (b ?? 0), 0)
      : null;

    if (total != null && (!bestRound || total < bestRound.total)) {
      bestRound = { player: card.player_name, round: card.round, total, toPar };
    }

    const birdieOrBetter = diffs.filter(d => d != null && d <= -1).length;
    if (!mostBirdiesRound || birdieOrBetter > mostBirdiesRound.count) {
      mostBirdiesRound = { player: card.player_name, round: card.round, count: birdieOrBetter };
    }

    const streak = longestStreak(diffs);
    if (streak && (!longest || streak.length > longest.length)) {
      longest = { player: card.player_name, round: card.round, ...streak };
    }

    const front = card[`out_${basis}`];
    const back = card[`in_${basis}`];
    if (front != null && (!lowestFront || front < lowestFront.total)) {
      lowestFront = { player: card.player_name, round: card.round, total: front };
    }
    if (back != null && (!lowestBack || back < lowestBack.total)) {
      lowestBack = { player: card.player_name, round: card.round, total: back };
    }
  }

  return { bestRound, mostBirdiesRound, longestStreak: longest, lowestFront, lowestBack };
}

// Round 2 vs round 1 net-total improvement — only meaningful for a
// multi-round format (Solo Ringer). Biggest positive drop wins; a player
// needs both rounds complete to be eligible.
function buildMostImproved(cards) {
  const byPlayer = new Map();
  for (const card of cards) {
    const key = card.player_name.toLowerCase();
    if (!byPlayer.has(key)) byPlayer.set(key, { name: card.player_name, rounds: {} });
    byPlayer.get(key).rounds[card.round] = card.total_net;
  }
  let best = null;
  for (const p of byPlayer.values()) {
    const r1 = p.rounds[1], r2 = p.rounds[2];
    if (r1 == null || r2 == null) continue;
    const improvement = r1 - r2; // positive = better round 2
    if (!best || improvement > best.improvement) {
      best = { player: p.name, round1: r1, round2: r2, improvement };
    }
  }
  return best;
}

// ─── Team-level tallies (team formats only) ────────────────────────────────

function resolveTeamGroups(cards, teamSize) {
  const teams = new Map(); // key -> { displayMembers, cards: [] }
  for (const card of cards) {
    const fields = Array.from({ length: teamSize }, (_, i) => card[`TeamPlayer${i + 1}`]).filter(Boolean);
    if (!fields.length) continue;
    const key = fields.map(p => p.toLowerCase()).sort().join('|');
    if (!teams.has(key)) teams.set(key, { displayMembers: fields, cards: [] });
    teams.get(key).cards.push(card);
  }
  return [...teams.values()].filter(t => t.cards.length === teamSize);
}

function buildTeamStats(cards, teamSize) {
  const teams = resolveTeamGroups(cards, teamSize);
  if (!teams.length) return null;

  let bestGrossAgg = null, bestNetAgg = null;
  let mostBirdiesGross = null, mostBirdiesNet = null;
  let mostBalanced = null, mostCarried = null;

  for (const team of teams) {
    const grossAgg = team.cards.reduce((s, c) => s + (c.total_gross ?? 0), 0);
    const netAgg = team.cards.reduce((s, c) => s + (c.total_net ?? 0), 0);
    if (!bestGrossAgg || grossAgg < bestGrossAgg.total) bestGrossAgg = { team: team.displayMembers, total: grossAgg };
    if (!bestNetAgg || netAgg < bestNetAgg.total) bestNetAgg = { team: team.displayMembers, total: netAgg };

    const birdiesGross = team.cards.reduce((s, c) => s + sumBucket(holeDiffs(c, 'gross'), 'birdie') + sumBucket(holeDiffs(c, 'gross'), 'eagle'), 0);
    const birdiesNet = team.cards.reduce((s, c) => s + sumBucket(holeDiffs(c, 'net'), 'birdie') + sumBucket(holeDiffs(c, 'net'), 'eagle'), 0);
    if (!mostBirdiesGross || birdiesGross > mostBirdiesGross.count) mostBirdiesGross = { team: team.displayMembers, count: birdiesGross };
    if (!mostBirdiesNet || birdiesNet > mostBirdiesNet.count) mostBirdiesNet = { team: team.displayMembers, count: birdiesNet };

    const nets = team.cards.map(c => c.total_net).filter(n => n != null);
    if (nets.length === teamSize) {
      const spread = Math.max(...nets) - Math.min(...nets);
      const worst = team.cards.find(c => c.total_net === Math.max(...nets));
      const best = team.cards.find(c => c.total_net === Math.min(...nets));
      const entry = { team: team.displayMembers, spread, carrier: best?.player_name, weakest: worst?.player_name };
      if (!mostBalanced || spread < mostBalanced.spread) mostBalanced = entry;
      if (!mostCarried || spread > mostCarried.spread) mostCarried = entry;
    }
  }

  return { bestGrossAgg, bestNetAgg, mostBirdiesGross, mostBirdiesNet, mostBalanced, mostCarried };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function buildEventSummary(scorecards, format) {
  const cards = scorecards.filter(isCardComplete);
  const numRounds = new Set(cards.map(c => c.round)).size || 1;
  const teamSize = format?.teamSize || 1;

  return {
    meta: {
      roundsPlayed: cards.length,
      playersCompleted: new Set(cards.map(c => c.player_name.toLowerCase())).size,
      numRounds,
    },
    eventStats: {
      gross: buildBasisEventStats(cards, 'gross'),
      net: buildBasisEventStats(cards, 'net'),
    },
    playerStats: {
      gross: buildPlayerStats(cards, 'gross'),
      net: buildPlayerStats(cards, 'net'),
      mostImproved: numRounds >= 2 ? buildMostImproved(cards) : null,
    },
    teamStats: teamSize > 1 ? buildTeamStats(cards, teamSize) : null,
  };
}
