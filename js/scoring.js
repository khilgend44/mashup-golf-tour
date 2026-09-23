// cache-bust: force a fresh Cloudflare response so the new no-cache header
// (see _headers) attaches to a genuine 200, not a stale revalidated 304.
export function applyFormat(scorecards, format, event = null) {
  const cards = applyManualOverrides(scorecards, event);
  switch (format.type) {
    case 'ringer':          return calcRinger(cards, format);
    case 'escalator-doom':  return calcEscalatorDoom(cards, format, event);
    case 'lone-ranger':     return calcLoneRanger(cards, format, event);
    case 'shamble-2man':      return calcShamble2Man(cards, format, event);
    case 'nassau-2man':       return calcNassau2Man(cards, format, event);
    case 'best2-worst2-all3': return calcBest2Worst2All3(cards, format, event);
    case 'modified-bb-3man':  return calcModifiedBB3Man(cards, format, event);
    case 'best-ball-3man':    return calcBestBall3Man(cards, format, event);
    case 'devils-draw':           return calcDevilsDraw(cards, format, event);
    case 'stableford-3man':       return calcStableford3Man(cards, format, event);
    case 'devils-draw-4man':  return calcDevilsDraw4Man(cards, format, event);
    default: throw new Error(`Unknown format: ${format.type}`);
  }
}

// Manual leaderboard overrides (DQ a player, or correct specific hole scores).
// They live on the event (merged from data/overrides.json) so they survive the
// 10-minute scorecard refresh — the raw scorecard files are never edited.
//   event.dq             = ["player", ...]                       full disqualification
//   event.scoreOverrides = [{ player, hole, net, gross?, round? }]  per-hole correction
// round is optional (omit to apply to every round a player has).
function applyManualOverrides(scorecards, event) {
  if (!event) return scorecards;
  const dq = new Set((event.dq || []).map(p => String(p).toLowerCase()));
  const overrides = event.scoreOverrides || [];
  if (!dq.size && !overrides.length) return scorecards;

  let cards = dq.size
    ? scorecards.filter(c => !dq.has(String(c.player_name || '').toLowerCase()))
    : scorecards;

  if (overrides.length) {
    const byPlayer = {};
    for (const o of overrides) (byPlayer[String(o.player || '').toLowerCase()] ||= []).push(o);
    cards = cards.map(c => {
      const ovs = byPlayer[String(c.player_name || '').toLowerCase()];
      if (!ovs) return c;
      const copy = { ...c };
      let changed = false;
      for (const o of ovs) {
        if (o.round != null && Number(o.round) !== Number(c.round)) continue;
        const h = Number(o.hole);
        if (h >= 1 && h <= 18) {
          if (o.net   != null) { copy[`hole${h}_net`]   = o.net;   changed = true; }
          if (o.gross != null) { copy[`hole${h}_gross`] = o.gross; }
        }
      }
      if (changed) {
        let tot = 0;
        for (let i = 1; i <= 18; i++) tot += Number(copy[`hole${i}_net`]) || 0;
        copy.total_net = tot;
      }
      return copy;
    });
  }
  return cards;
}

// SGT sometimes leaves a fully-played round's status as "Pending" instead of
// flipping it to "Completed" (confirmed 2026-09, S10W1 — a player's round
// with all 18 holes scored, and confirmed showing as done on SGT's own site,
// stayed "Pending" through several fetch cycles). Treat a round as complete
// if it's explicitly Completed, OR marked Pending but every hole already has
// a recorded net score.
//
// That "every hole has a value" check alone isn't enough, though: while a
// round is genuinely in progress, SGT fills holes not yet played with a
// literal 0 (not null) — hole${i}_net is never actually missing, so the old
// all-non-null check saw a false completion the moment ANY holes were
// filled in, and treated the 0s as real (super-low) scores. Confirmed
// 2026-09, S10W1 — two players mid-round-1 showed as -61/-54 on the
// leaderboard. `activeHole` (1-18 while still playing, 19 once truly done)
// is the reliable signal — check it first, and only fall back to the
// all-holes-present heuristic when it's missing, to still catch the
// separate stuck-on-Pending case above.
export function isCardComplete(card) {
  if (card.status === 'Completed') return true;
  if (card.status !== 'Pending') return false;
  if (card.activeHole != null && card.activeHole <= 18) return false;
  for (let i = 1; i <= 18; i++) {
    if (card[`hole${i}_net`] == null) return false;
  }
  return true;
}

// Has this player actually recorded a stroke yet, vs. a card that's all
// zero-placeholder holes because they haven't teed off? Used to decide
// whether an incomplete round is worth surfacing as "in progress" on the
// leaderboard.
function cardHasStarted(card) {
  for (let i = 1; i <= 18; i++) {
    if (card[`hole${i}_net`] > 0) return true;
  }
  return false;
}

// Fallback team lookup from KV event.teams (used when SGT TeamPlayer fields are absent).
// Returns map of lowercase player name → { key, displayMembers }, or null if no KV teams.
function buildKvTeamMap(event) {
  if (!event?.teams?.length) return null;
  const map = {};
  for (const team of event.teams) {
    const key = team.map(p => p.toLowerCase()).sort().join('|');
    for (const p of team) map[p.toLowerCase()] = { key, displayMembers: [...team] };
  }
  return map;
}

function resolveTeamKey(card, sgtFields, kvTeamMap) {
  // Admin-defined teams (event.teams, via KV) are authoritative when present.
  // SGT's per-card TeamPlayer fields are occasionally returned incomplete
  // (one or more slots blank), which fragments a single team into partial
  // teams + solo players. Preferring the KV map avoids that.
  if (kvTeamMap) {
    // Direct membership in a defined team.
    const kv = kvTeamMap[card.player_name.toLowerCase()];
    if (kv) return { key: kv.key, displayMembers: kv.displayMembers, fromKv: true };
    // Sub: player isn't on a roster team but lists a teammate who is — attach
    // them to that team so their scores count under the right group.
    for (const p of sgtFields) {
      const m = p && kvTeamMap[p.toLowerCase()];
      if (m) return { key: m.key, displayMembers: m.displayMembers, fromKv: true };
    }
  }
  const raw = sgtFields.filter(p => p);
  if (raw.length > 0) return { key: raw.map(p => p.toLowerCase()).sort().join('|'), displayMembers: raw, fromKv: false };
  return { key: '', displayMembers: [], fromKv: false };
}

// ─── Solo Ringer ────────────────────────────────────────────────────────────

function calcRinger(scorecards, format) {
  const basis = format.scoringBasis;
  const players = {};

  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const name = card.player_name;
    if (!players[name]) {
      players[name] = {
        player_name: name,
        ringerCard: Array(18).fill(null),
        ringerRound: Array(18).fill(null),
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
        roundsPlayed: 0,
        totalNetAllRounds: 0,
        rounds: [],
      };
    }
    players[name].roundsPlayed++;
    players[name].totalNetAllRounds += card.total_net;
    const scores = Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_${basis}`]);
    const grossScores = Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_gross`]);
    players[name].rounds.push({
      round: card.round,
      net: scores,
      gross: grossScores,
      total: card.total_net,
    });
    for (let i = 0; i < 18; i++) {
      const s = scores[i];
      if (s > 0 && (players[name].ringerCard[i] === null || s < players[name].ringerCard[i])) {
        players[name].ringerCard[i] = s;
        players[name].ringerRound[i] = card.round;
      }
    }
  }

  const results = Object.values(players).map(p => {
    const card = p.ringerCard.map(s => s ?? 0);
    const out = card.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = card.slice(9).reduce((a, b) => a + b, 0);
    const outPar = p.pars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = p.pars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const rounds = [...p.rounds].sort((a, b) => a.round - b.round);
    return {
      isTeam: false,
      player_name: p.player_name,
      ringerCard: card,
      ringerRound: p.ringerRound,
      rounds,
      pars: p.pars,
      indices: p.indices,
      roundsPlayed: p.roundsPlayed,
      totalNetAllRounds: p.totalNetAllRounds,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      prize: null,
    };
  });

  rankAndPosition(results);

  // Players actively mid-round with no complete round yet don't get a
  // ringer total at all (their only card was skipped above) — surface them
  // unranked instead of just silently dropping them off the leaderboard.
  // A partial ringer total built from a still-in-progress round would be
  // wildly wrong (the unplayed holes are 0s, not blanks) — but the holes
  // they HAVE played are real, so a partial scorecard is still worth
  // showing. `activeHole` (1-18) marks how far they've gotten; holes at or
  // past it come back from SGT as a 0 placeholder, not a real score, so
  // those are nulled out here rather than displayed as strokes.
  // A player can also be *already ranked* (round 1 done) while a later
  // round is mid-flight (round 2 started) — that in-progress round isn't
  // just "no data yet" in that case, it needs to attach to their existing
  // result so the scorecard shows it, not get skipped because they already
  // have a complete round on file.
  const resultsByName = new Map(results.map(r => [r.player_name.toLowerCase(), r]));
  const seenInProgress = new Set();
  let ringerImproved = false;
  for (const card of scorecards) {
    if (card.status !== 'Pending' || isCardComplete(card) || !cardHasStarted(card)) continue;
    const key = card.player_name.toLowerCase();
    if (seenInProgress.has(key)) continue; // only one in-progress round shown per player
    seenInProgress.add(key);
    const pars = Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]);
    const indices = Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]);
    // Fall back to "any hole with a >0 net is played" if activeHole is ever
    // missing — less precise (can't tell a real 0 from an unplayed hole),
    // but keeps the scorecard from crashing rather than showing nothing.
    const holesPlayed = card.activeHole != null ? Math.max(0, Math.min(18, card.activeHole - 1)) : null;
    const isPlayed = i => holesPlayed != null ? i < holesPlayed : card[`hole${i + 1}_net`] > 0;
    const net = Array.from({ length: 18 }, (_, i) => isPlayed(i) ? card[`hole${i + 1}_net`] : null);
    const gross = Array.from({ length: 18 }, (_, i) => isPlayed(i) ? card[`hole${i + 1}_gross`] : null);
    const liveRound = { round: card.round, net, gross, total: null };
    const liveHolesPlayed = holesPlayed ?? net.filter(n => n != null).length;

    const existing = resultsByName.get(key);
    if (existing) {
      // Already ranked off a completed round — append the live round so the
      // scorecard shows it too, and flag it for a "LIVE" badge on the row.
      existing.rounds = [...existing.rounds, liveRound];
      existing.hasLiveRound = true;
      existing.liveHolesPlayed = liveHolesPlayed;

      // A hole the live round has actually played is real, settled data —
      // it isn't going to get worse later in the same round — so it's
      // fair game for the ringer card immediately, same as any other
      // round's hole would be. Confirmed 2026-09: a live round-2 hole beat
      // the round-1 ringer score and the card wasn't picking it up until
      // the round finished. Only update where net[i] is a real recorded
      // stroke (never the 0-placeholder for a hole not yet reached).
      for (let i = 0; i < 18; i++) {
        const s = net[i];
        if (s != null && s > 0 && s < existing.ringerCard[i]) {
          existing.ringerCard[i] = s;
          existing.ringerRound[i] = card.round;
          ringerImproved = true;
        }
      }
      if (ringerImproved) {
        existing.out = existing.ringerCard.slice(0, 9).reduce((a, b) => a + b, 0);
        existing.inn = existing.ringerCard.slice(9).reduce((a, b) => a + b, 0);
        existing.total = existing.out + existing.inn;
        existing.toPar = existing.total - existing.totalPar;
      }
    } else {
      results.push({
        isTeam: false,
        player_name: card.player_name,
        inProgress: true,
        position: null,
        roundsPlayed: 0,
        total: null,
        toPar: null,
        prize: null,
        pars,
        indices,
        outPar: pars.slice(0, 9).reduce((a, b) => a + b, 0),
        inPar: pars.slice(9).reduce((a, b) => a + b, 0),
        totalPar: pars.reduce((a, b) => a + b, 0),
        holesPlayed: liveHolesPlayed,
        ringerCard: Array(18).fill(null),
        ringerRound: Array(18).fill(null),
        rounds: [liveRound],
        totalNetAllRounds: 0,
      });
    }
  }

  // A live round's hole may have just bumped someone's ringer total down —
  // real settled data, so re-rank rather than leaving the position stale
  // until the round finishes. In-progress-only entries (no complete round
  // at all yet) have no total to rank by and stay unranked at the end.
  if (ringerImproved) {
    const ranked = results.filter(r => !r.inProgress);
    const unranked = results.filter(r => r.inProgress);
    rankAndPosition(ranked);
    return [...ranked, ...unranked];
  }

  return results;
}

// Sorts `list` by ringer total (then the 36-hole tiebreaker, then index
// countback) and assigns `position`/`tied` in place. Shared by the initial
// ranking and any later re-rank once a live round's hole improves someone's
// ringer card.
function rankAndPosition(list) {
  list.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.totalNetAllRounds !== b.totalNetAllRounds) return a.totalNetAllRounds - b.totalNetAllRounds;
    return indexCountback(a, b);
  });
  list.forEach((curr, i) => {
    if (i === 0) { curr.position = 1; curr.tied = false; return; }
    const prev = list[i - 1];
    const trulyTied = curr.total === prev.total &&
      curr.totalNetAllRounds === prev.totalNetAllRounds &&
      indexCountback(curr, prev) === 0;
    curr.position = trulyTied ? prev.position : i + 1;
    curr.tied = trulyTied;
    if (trulyTied) prev.tied = true;
  });
}

function indexCountback(a, b) {
  const sorted = Array.from({ length: 18 }, (_, i) => i).sort((x, y) => a.indices[x] - a.indices[y]);
  for (const h of sorted) { const d = a.ringerCard[h] - b.ringerCard[h]; if (d !== 0) return d; }
  return 0;
}

// ─── Escalator of Doom ──────────────────────────────────────────────────────

function calcEscalatorDoom(scorecards, format, event) {
  // Build player card lookup
  const cardsByPlayer = {};
  for (const card of scorecards) {
    if (isCardComplete(card)) cardsByPlayer[card.player_name.toLowerCase()] = card;
  }

  const kvTeamMap = buildKvTeamMap(event);

  // Teammates can play hours apart, so "who's on this team" can't only
  // come from whoever already has a card — seed the full roster from the
  // admin-defined draw (event.teams) first, so a member who hasn't teed
  // off at all still shows as "not started" rather than the team just
  // looking short-handed or not appearing. Falls back to whatever SGT's
  // TeamPlayer fields reveal when there's no KV draft (older/edge-case
  // events), same as resolveTeamKey already does elsewhere.
  const teams = {}; // key -> { displayMembers, memberStatus: Map(lowerName -> {...}), pars, indices }
  function ensureTeam(key, displayMembers) {
    if (!teams[key]) {
      teams[key] = { displayMembers: [...displayMembers], memberStatus: new Map(), pars: null, indices: null };
    }
    return teams[key];
  }

  if (event?.teams?.length) {
    for (const roster of event.teams) {
      const key = roster.map(p => p.toLowerCase()).sort().join('|');
      const team = ensureTeam(key, roster);
      for (const name of roster) {
        team.memberStatus.set(name.toLowerCase(), { name, status: 'not-started' });
      }
    }
  }

  for (const card of scorecards) {
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    const team = ensureTeam(key, displayMembers);
    if (!team.pars) {
      team.pars = Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]);
      team.indices = Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]);
    }
    const nameKey = card.player_name.toLowerCase();
    if (isCardComplete(card)) {
      team.memberStatus.set(nameKey, {
        name: card.player_name,
        status: 'complete',
        isSub: false,
        net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
        totalNet: card.total_net,
      });
    } else if (card.status === 'Pending' && cardHasStarted(card)) {
      const holesPlayed = card.activeHole != null ? Math.max(0, Math.min(18, card.activeHole - 1)) : null;
      team.memberStatus.set(nameKey, {
        name: card.player_name,
        status: 'live',
        holesPlayed: holesPlayed ?? 0,
      });
    } else if (!team.memberStatus.has(nameKey)) {
      team.memberStatus.set(nameKey, { name: card.player_name, status: 'not-started' });
    }
  }

  // Apply substitutions from event config — only meaningful once the sub
  // actually has a completed card; a sub who hasn't played yet just shows
  // up as "not started" under their own name via the loop above.
  for (const sub of (event?.substitutions ?? [])) {
    const origKey = sub.originalPlayers.map(p => p.toLowerCase()).sort().join('|');
    const team = teams[origKey];
    const subCard = cardsByPlayer[sub.with.toLowerCase()];
    if (!team || !subCard) continue;

    team.memberStatus.delete(sub.replace.toLowerCase());
    team.memberStatus.set(sub.with.toLowerCase(), {
      name: sub.with,
      status: 'complete',
      isSub: true,
      net: Array.from({ length: 18 }, (_, i) => subCard[`hole${i + 1}_net`]),
      totalNet: subCard.total_net,
    });
    const ri = team.displayMembers.findIndex(p => p.toLowerCase() === sub.replace.toLowerCase());
    if (ri >= 0) team.displayMembers[ri] = sub.with + ' (sub)';
  }

  const teamSize = format.teamSize || 3;
  const results = [];
  for (const team of Object.values(teams)) {
    const members = [...team.memberStatus.values()];
    const completePlayers = members.filter(m => m.status === 'complete');

    // Only score a team once every roster spot is a completed card — the
    // back-6 "all N score" segment would otherwise silently use however
    // many happen to be done instead of the real team size, understating
    // the team's true total for as long as it's short-handed. Confirmed
    // 2026-09: worth fixing alongside adding "in progress" support, not
    // just cosmetic — a genuinely wrong number is worse than no number.
    if (completePlayers.length < teamSize || members.length < teamSize) {
      const hasActivity = members.some(m => m.status !== 'not-started');
      if (hasActivity) {
        // Provisional to-par from whoever's actually finished so far —
        // NOT the real ranked total (that still requires all `teamSize`
        // complete, per the fix above), just "how the team stands right
        // now." Reuses the same per-segment "best N of the field" idea as
        // the real scoring, capped to however many are actually in:
        // 1 player -> their own round IS the provisional total (countN=1
        // everywhere, since you can't have more counters than players);
        // 2 players -> best-of-2 on holes 1-6 (correctly matches the real
        // 1BB rule already), both players summed on 7-18 (an approximation
        // of 2BB/all-3 using what's available); par is scaled by that same
        // countN each hole, not the segment's final required count, so
        // the to-par comparison stays fair at every stage and converges
        // exactly to the real total once the 3rd player completes.
        let provisionalToPar = null;
        if (completePlayers.length > 0 && team.pars) {
          let provTotal = 0, provPar = 0;
          for (let h = 0; h < 18; h++) {
            const segmentCount = h < 6 ? 1 : h < 12 ? 2 : teamSize;
            const countN = Math.min(segmentCount, completePlayers.length);
            const sorted = completePlayers.map(p => p.net[h]).sort((a, b) => a - b);
            provTotal += sorted.slice(0, countN).reduce((a, b) => a + b, 0);
            provPar += team.pars[h] * countN;
          }
          provisionalToPar = provTotal - provPar;
        }
        results.push({
          isTeam: true,
          inProgress: true,
          position: null,
          displayMembers: team.displayMembers,
          members,
          teamSize,
          total: null,
          toPar: provisionalToPar,
          aggregate: null,
          prize: null,
        });
      }
      continue;
    }

    const adjPars = team.pars.map((p, i) => i < 6 ? p : i < 12 ? p * 2 : p * 3);

    const countingPlayers = [];   // countingPlayers[hole][playerIdx] = true/false
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const ranked = completePlayers
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const countN = h < 6 ? 1 : h < 12 ? 2 : completePlayers.length;
      const counting = new Array(completePlayers.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(countN, ranked.length); i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out    = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn    = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar  = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total  = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = completePlayers.reduce((s, p) => s + p.totalNet, 0);

    results.push({
      isTeam: true,
      displayMembers: team.displayMembers,
      players: completePlayers,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    });
  }

  // Sort: team total → net aggregate tiebreaker. In-progress entries have
  // no total to sort by and stay unranked at the end.
  const ranked = results.filter(r => !r.inProgress);
  const unranked = results.filter(r => r.inProgress);
  ranked.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  ranked.forEach((curr, i) => {
    if (i === 0) { curr.position = 1; curr.tied = false; return; }
    const prev = ranked[i - 1];
    const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
    curr.position = trulyTied ? prev.position : i + 1;
    curr.tied = trulyTied;
    if (trulyTied) prev.tied = true;
  });

  return [...ranked, ...unranked];
}

// ─── Devil's Draw ───────────────────────────────────────────────────────────

function calcDevilsDraw(scorecards, format, event) {
  if (!event?.devilsDraw) return [];

  // Build hole category map (1-indexed hole → count: 3, 2, 1, or 0)
  const holeCount = {};
  for (const h of (event.devilsDraw['3bb']  ?? [])) holeCount[h] = 3;
  for (const h of (event.devilsDraw['2bb']  ?? [])) holeCount[h] = 2;
  for (const h of (event.devilsDraw['1bb']  ?? [])) holeCount[h] = 1;
  for (const h of (event.devilsDraw['zero'] ?? [])) holeCount[h] = 0;

  const kvTeamMap = buildKvTeamMap(event);

  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    const adjPars = Array.from({ length: 18 }, (_, i) => {
      const count = holeCount[i + 1] ?? 1;
      return team.pars[i] * count;
    });

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const count = holeCount[h + 1] ?? 1;
      if (count === 0) {
        countingPlayers.push(new Array(team.players.length).fill(false));
        return 0;
      }
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(count, ranked.length); i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar  = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total  = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      holeCount,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── 3-Man Modified Stableford ──────────────────────────────────────────────

function toStablefordPts(net, par) {
  const diff = net - par;
  if (diff >= 2)   return 0;   // double bogey or worse
  if (diff === 1)  return 1;   // bogey
  if (diff === 0)  return 2;   // par
  if (diff === -1) return 4;   // birdie
  if (diff === -2) return 6;   // eagle
  return 10;                   // albatross or better
}

function calcStableford3Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars:    Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    const pars = Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]);
    const net  = Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]);
    const pts  = net.map((n, i) => toStablefordPts(n, pars[i]));
    teams[key].players.push({
      name: card.player_name,
      net,
      pts,
      totalNet: card.total_net,
      individualTotal: pts.reduce((a, b) => a + b, 0),
    });
  }

  const results = Object.values(teams).map(team => {
    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      // Top 2 stableford points per hole
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.pts[h] }))
        .sort((a, b) => b.score - a.score);
      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(2, ranked.length); i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out      = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn      = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const total    = out + inn;
    const aggregate = team.players.reduce((s, p) => s + p.individualTotal, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      holeCount: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 1, 2])),
      teamHoleScores,
      countingPlayers,
      pars:    team.pars,
      adjPars: team.pars,  // no adjustment — par is par
      indices: team.indices,
      out, inn,
      outPar:   team.pars.slice(0, 9).reduce((a, b) => a + b, 0),
      inPar:    team.pars.slice(9).reduce((a, b) => a + b, 0),
      totalPar: team.pars.reduce((a, b) => a + b, 0),
      total,
      toPar:    total,  // repurposed: holds team points total
      aggregate,
      prize: null,
    };
  });

  // High score wins: sort descending by total, then aggregate, then index countback (top-2 per hole)
  results.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.aggregate !== a.aggregate) return b.aggregate - a.aggregate;
    // Hole-by-hole countback from index #1 using top-2 stableford
    const idxOrder = Array.from({ length: 18 }, (_, i) => i)
      .sort((x, y) => (a.indices[x] || 99) - (a.indices[y] || 99));
    for (const h of idxOrder) {
      if (a.teamHoleScores[h] !== b.teamHoleScores[h]) return b.teamHoleScores[h] - a.teamHoleScores[h];
    }
    return 0;
  });

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── Devil's Draw (4-Man) ───────────────────────────────────────────────────

function calcDevilsDraw4Man(scorecards, format, event) {
  if (!event?.devilsDraw) return [];

  const holeCount = {};
  for (const h of (event.devilsDraw['4bb']  ?? [])) holeCount[h] = 4;
  for (const h of (event.devilsDraw['3bb']  ?? [])) holeCount[h] = 3;
  for (const h of (event.devilsDraw['2bb']  ?? [])) holeCount[h] = 2;
  for (const h of (event.devilsDraw['1bb']  ?? [])) holeCount[h] = 1;
  for (const h of (event.devilsDraw['zero'] ?? [])) holeCount[h] = 0;

  const kvTeamMap = buildKvTeamMap(event);

  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3, card.TeamPlayer4], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    const adjPars = Array.from({ length: 18 }, (_, i) => {
      const count = holeCount[i + 1] ?? 1;
      return team.pars[i] * count;
    });

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const count = holeCount[h + 1] ?? 1;
      if (count === 0) {
        countingPlayers.push(new Array(team.players.length).fill(false));
        return 0;
      }
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(count, ranked.length); i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar  = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total  = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      holeCount,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── Best 2, Worst 2, All 3 ─────────────────────────────────────────────────

function calcBest2Worst2All3(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    const adjPars = team.pars.map(p => p === 3 ? p * 3 : p * 2);

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const par = team.pars[h];
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);

      // par 3 → all 3; par 5 → best 2 (lowest); par 4 → worst 2 (highest)
      const countN = par === 3 ? 3 : 2;
      if (par === 4) ranked.reverse();

      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < countN; i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── 3-Man Modified BB ──────────────────────────────────────────────────────
// Every hole: par 5 → 1 net best ball, par 4 → 2 net best balls, par 3 → all 3
// net scores. Lowest 18-hole team total wins. Tie → team net aggregate.
function countForPar(par) {
  return par === 5 ? 1 : par === 4 ? 2 : 3;
}

function calcModifiedBB3Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    const adjPars = team.pars.map(p => p * countForPar(p));

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const countN = countForPar(team.pars[h]);
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(countN, ranked.length); i++) {
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── 3-Man, 2 Best Ball ─────────────────────────────────────────────────────
// Every hole: sum the two lowest NET scores among the three teammates. Lowest
// 18-hole team total wins. Tie → total team aggregate (all three players' net
// over 18 holes).
function calcBestBall3Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const COUNT_N = 2; // two best balls count on every hole
  const results = Object.values(teams).map(team => {
    // Two balls count each hole → par doubles for the to-par display.
    const adjPars = team.pars.map(p => p * COUNT_N);

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      // Treat 0/null as a missing score so it can't be picked as a "best".
      const ranked = team.players
        .map((p, idx) => ({ idx, score: (p.net[h] === null || p.net[h] === 0) ? Infinity : p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const counting = new Array(team.players.length).fill(false);
      let total = 0;
      for (let i = 0; i < Math.min(COUNT_N, ranked.length); i++) {
        if (ranked[i].score === Infinity) continue;
        counting[ranked[i].idx] = true;
        total += ranked[i].score;
      }
      countingPlayers.push(counting);
      return total;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── 2-Man Shamble ──────────────────────────────────────────────────────────

function calcShamble2Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      // Treat 0 or null as missing — use the other player's score
      const effective = team.players.map(p => {
        const s = p.net[h];
        return (s === null || s === 0) ? Infinity : s;
      });
      const best = Math.min(...effective);
      const counting = team.players.map((_, i) => best !== Infinity && effective[i] === best);
      countingPlayers.push(counting);
      return best === Infinity ? 0 : best;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = team.pars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = team.pars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars: team.pars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.aggregate !== b.aggregate) return a.aggregate - b.aggregate;
    return shambleCountback(a, b);
  });

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total &&
        curr.aggregate === prev.aggregate &&
        shambleCountback(curr, prev) === 0;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

function shambleCountback(a, b) {
  const sorted = Array.from({ length: 18 }, (_, i) => i).sort((x, y) => a.indices[x] - a.indices[y]);
  for (const h of sorted) {
    const d = a.teamHoleScores[h] - b.teamHoleScores[h];
    if (d !== 0) return d;
  }
  return 0;
}

// ─── 2-Man Modified Nassau ──────────────────────────────────────────────────

function calcNassau2Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};

  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  const results = Object.values(teams).map(team => {
    // Best Ball per hole (18-hole BB competition)
    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const effective = team.players.map(p => {
        const s = p.net[h];
        return (s === null || s === 0) ? Infinity : s;
      });
      const best = Math.min(...effective);
      const counting = team.players.map((_, i) => best !== Infinity && effective[i] === best);
      countingPlayers.push(counting);
      return best === Infinity ? 0 : best;
    });

    const out      = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn      = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar   = team.pars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar    = team.pars.slice(9).reduce((a, b) => a + b, 0);
    const total    = out + inn;
    const totalPar = outPar + inPar;

    // Aggregate scores: sum of both players' individual nets per half
    const f9Agg = team.players.reduce((s, p) =>
      s + p.net.slice(0, 9).reduce((a, v) => a + (v == null ? 0 : v), 0), 0);
    const b9Agg = team.players.reduce((s, p) =>
      s + p.net.slice(9).reduce((a, v) => a + (v == null ? 0 : v), 0), 0);
    const aggregate = f9Agg + b9Agg;

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars: team.pars,
      indices: team.indices,
      out, inn, outPar, inPar,
      total, totalPar,
      toPar: total - totalPar,
      bbScore: total,
      f9Agg, b9Agg, aggregate,
      potWon: null,
      position: 1,
      prize: null,
    };
  });

  if (results.length === 0) return results;

  const sortBB = (a, b) => a.bbScore  !== b.bbScore  ? a.bbScore  - b.bbScore
    : a.aggregate !== b.aggregate ? a.aggregate - b.aggregate : nassauCB18(a, b);
  const sortF9 = (a, b) => a.f9Agg   !== b.f9Agg   ? a.f9Agg   - b.f9Agg
    : a.aggregate !== b.aggregate ? a.aggregate - b.aggregate : nassauCBF9(a, b);
  const sortB9 = (a, b) => a.b9Agg   !== b.b9Agg   ? a.b9Agg   - b.b9Agg
    : a.aggregate !== b.aggregate ? a.aggregate - b.aggregate : nassauCBB9(a, b);

  // Assign pot winners (no-double-win: each team wins at most one pot)
  [...results].sort(sortBB)[0].potWon = 'bb';
  for (const t of [...results].sort(sortF9)) { if (!t.potWon) { t.potWon = 'f9'; break; } }
  for (const t of [...results].sort(sortB9)) { if (!t.potWon) { t.potWon = 'b9'; break; } }

  // Sort leaderboard by BB score
  results.sort(sortBB);
  for (let i = 0; i < results.length; i++) {
    if (i === 0) { results[0].position = 1; continue; }
    const prev = results[i - 1], curr = results[i];
    const tied = sortBB(curr, prev) === 0;
    curr.position = tied ? prev.position : i + 1;
    if (tied) { curr.tied = true; prev.tied = true; }
  }

  // Side pot: best individual nets from players NOT on any pot-winning team
  const potWinnerSet = new Set(
    results.filter(t => t.potWon).flatMap(t => t.displayMembers.map(p => p.toLowerCase()))
  );
  const sideCandidates = results
    .flatMap(t => t.players.map(p => ({ name: p.name, individualNet: p.totalNet })))
    .filter(p => !potWinnerSet.has(p.name.toLowerCase()))
    .sort((a, b) => a.individualNet - b.individualNet);

  results.nassauSidePot = sideCandidates.slice(0, 2);
  results.nassauPots = {
    bb: results.find(t => t.potWon === 'bb') || null,
    f9: results.find(t => t.potWon === 'f9') || null,
    b9: results.find(t => t.potWon === 'b9') || null,
  };

  // Assign prizes from event.nassauPrizes if configured
  if (event?.nassauPrizes) {
    const np = event.nassauPrizes;
    for (const t of results) {
      if (t.potWon === 'bb' && np.bb) t.prize = np.bb;
      if (t.potWon === 'f9' && np.f9) t.prize = np.f9;
      if (t.potWon === 'b9' && np.b9) t.prize = np.b9;
    }
  }

  return results;
}

function nassauCB18(a, b) {
  const sorted = Array.from({ length: 18 }, (_, i) => i).sort((x, y) => a.indices[x] - a.indices[y]);
  for (const h of sorted) {
    const d = a.teamHoleScores[h] - b.teamHoleScores[h];
    if (d !== 0) return d;
  }
  return 0;
}

function nassauCBF9(a, b) {
  const sorted = Array.from({ length: 9 }, (_, i) => i).sort((x, y) => a.indices[x] - a.indices[y]);
  for (const h of sorted) {
    const ah = a.players.reduce((s, p) => s + (p.net[h] || 0), 0);
    const bh = b.players.reduce((s, p) => s + (p.net[h] || 0), 0);
    if (ah !== bh) return ah - bh;
  }
  return 0;
}

function nassauCBB9(a, b) {
  const sorted = Array.from({ length: 9 }, (_, i) => i + 9).sort((x, y) => a.indices[x] - a.indices[y]);
  for (const h of sorted) {
    const ah = a.players.reduce((s, p) => s + (p.net[h] || 0), 0);
    const bh = b.players.reduce((s, p) => s + (p.net[h] || 0), 0);
    if (ah !== bh) return ah - bh;
  }
  return 0;
}

// ─── 3-Man Lone Ranger ──────────────────────────────────────────────────────

function calcLoneRanger(scorecards, format, event) {
  const cardsByPlayer = {};
  for (const card of scorecards) {
    if (isCardComplete(card)) cardsByPlayer[card.player_name.toLowerCase()] = card;
  }

  const kvTeamMap = buildKvTeamMap(event);

  const teams = {};
  for (const card of scorecards) {
    if (!isCardComplete(card)) continue;
    const { key, displayMembers } = resolveTeamKey(card, [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3], kvTeamMap);
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...displayMembers],
        players: [],
        pars: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_Par`]),
        indices: Array.from({ length: 18 }, (_, i) => card[`h${i + 1}_index`]),
      };
    }
    teams[key].players.push({
      name: card.player_name,
      isSub: false,
      net: Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_net`]),
      totalNet: card.total_net,
    });
  }

  for (const sub of (event?.substitutions ?? [])) {
    const origKey = sub.originalPlayers.map(p => p.toLowerCase()).sort().join('|');
    const team = teams[origKey];
    const subCard = cardsByPlayer[sub.with.toLowerCase()];
    if (!team || !subCard) continue;
    team.players.push({
      name: sub.with,
      isSub: true,
      net: Array.from({ length: 18 }, (_, i) => subCard[`hole${i + 1}_net`]),
      totalNet: subCard.total_net,
    });
    const ri = team.displayMembers.findIndex(p => p.toLowerCase() === sub.replace.toLowerCase());
    if (ri >= 0) team.displayMembers[ri] = sub.with + ' (sub)';
  }

  // Build slot lookup: sorted player key → [slot1, slot2, slot3]
  const slotMap = {};
  for (const slots of (event?.teamSlots ?? [])) {
    const key = slots.map(p => p.toLowerCase()).sort().join('|');
    slotMap[key] = slots;
  }

  const results = Object.values(teams).map(team => {
    const adjPars = team.pars.map(p => p * 2);

    const teamKey = team.players.map(p => p.name.toLowerCase()).sort().join('|');
    const slots = slotMap[teamKey] ?? team.players.map(p => p.name);

    const playerByName = {};
    for (const p of team.players) playerByName[p.name.toLowerCase()] = p;
    const slotPlayers = slots.map(s => playerByName[s.toLowerCase()]);

    const countingPlayers = [];
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const lrPlayer = slotPlayers[h % 3];
      const others = slotPlayers.filter((_, i) => i !== h % 3);

      const lrScore = lrPlayer.net[h];
      let bbScore = Infinity, bbPlayer = null;
      for (const op of others) {
        if (op.net[h] < bbScore) { bbScore = op.net[h]; bbPlayer = op; }
      }

      const counting = new Array(team.players.length).fill(false);
      const lrIdx = team.players.findIndex(p => p.name.toLowerCase() === lrPlayer.name.toLowerCase());
      if (lrIdx >= 0) counting[lrIdx] = true;
      if (bbPlayer) {
        const bbIdx = team.players.findIndex(p => p.name.toLowerCase() === bbPlayer.name.toLowerCase());
        if (bbIdx >= 0) counting[bbIdx] = true;
      }
      countingPlayers.push(counting);
      return lrScore + bbScore;
    });

    const out = teamHoleScores.slice(0, 9).reduce((a, b) => a + b, 0);
    const inn = teamHoleScores.slice(9).reduce((a, b) => a + b, 0);
    const outPar = adjPars.slice(0, 9).reduce((a, b) => a + b, 0);
    const inPar = adjPars.slice(9).reduce((a, b) => a + b, 0);
    const total = out + inn;
    const totalPar = outPar + inPar;
    const aggregate = team.players.reduce((s, p) => s + p.totalNet, 0);

    return {
      isTeam: true,
      displayMembers: team.displayMembers,
      players: team.players,
      slots,
      teamHoleScores,
      countingPlayers,
      pars: team.pars,
      adjPars,
      indices: team.indices,
      out, inn, outPar, inPar, total, totalPar,
      toPar: total - totalPar,
      aggregate,
      prize: null,
    };
  });

  results.sort((a, b) => a.total !== b.total ? a.total - b.total : a.aggregate - b.aggregate);

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total && curr.aggregate === prev.aggregate;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
}

// ─── Payouts ────────────────────────────────────────────────────────────────

// Manual payouts: { place, player, amount } — matched case-insensitively.
// Auto payouts:   { place, amount }         — assigned by position, split on ties.
export function applyPayouts(results, payouts) {
  if (!payouts || !payouts.length) return;

  // Side pots are individual prizes shown in their own section — exclude from leaderboard prize column
  const mainPayouts = payouts.filter(p => !String(p.place).startsWith('side-'));
  if (!mainPayouts.length) return;

  if (mainPayouts.some(p => p.player)) {
    const map = {};
    for (const p of mainPayouts) if (p.player) map[p.player.toLowerCase()] = p.amount;
    for (const r of results) {
      if (r.inProgress) continue; // no final placement yet — prize stays null
      if (r.isTeam) {
        const matched = r.players.filter(p => map[p.name.toLowerCase()] != null);
        const majority = Math.ceil(r.players.length / 2);
        r.prize = matched.length >= majority ? (map[matched[0].name.toLowerCase()] ?? null) : null;
      } else {
        const key = r.player_name?.toLowerCase();
        r.prize = key ? (map[key] ?? null) : null;
      }
    }
  } else {
    const amountMap = Object.fromEntries(mainPayouts.map(p => [p.place, p.amount]));
    const groups = {};
    for (const r of results) {
      if (r.inProgress) continue; // no final placement yet — prize stays null
      if (!groups[r.position]) groups[r.position] = [];
      groups[r.position].push(r);
    }
    for (const [pos, group] of Object.entries(groups)) {
      const start = parseInt(pos);
      const combined = Array.from({ length: group.length }, (_, i) => amountMap[start + i] ?? 0)
        .reduce((a, b) => a + b, 0);
      const share = group.length > 1
        ? Math.round(combined / group.length * 100) / 100
        : (amountMap[start] ?? null);
      for (const r of group) r.prize = share || null;
    }
  }
}

// ─── Side pots ────────────────────────────────────────────────────────────────

// Resolve side-pot winners + amounts from event.sidePots. Shared by the season
// money standings and the leaderboard display so the winner logic lives in one
// place. Requires applyPayouts to have run (reads team.prize). Returns
// [{ player, amount }] for the paid positions only.
//   • Nassau: best individual nets not on a pot-winning team (results.nassauSidePot)
//   • Stableford: top individual points not on a prize-winning team
//   • Other team formats: best individual net not on a prize-winning team
export function resolveSidePots(results, event, format) {
  const pots = event?.sidePots || [];
  if (!pots.length || !Array.isArray(results)) return [];

  if (format?.type === 'nassau-2man') {
    const cand = results.nassauSidePot || [];
    return cand.slice(0, pots.length).map((p, i) => ({ player: p.name, amount: pots[i].amount }));
  }

  const isStableford = format?.type === 'stableford-3man';
  const winnerMembers = new Set(
    results.filter(t => t.prize != null).flatMap(t => (t.displayMembers || []).map(m => m.toLowerCase()))
  );
  const eligible = results
    .flatMap(team => (team.players || []).map(p => ({
      name: p.name,
      metric: isStableford ? p.individualTotal : p.totalNet,
    })))
    .filter(p => !winnerMembers.has(p.name.toLowerCase()))
    .sort((a, b) => isStableford ? b.metric - a.metric : a.metric - b.metric);

  return eligible.slice(0, pots.length).map((p, i) => ({ player: p.name, amount: pots[i].amount }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function formatToPar(n) {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : String(n);
}

export function holeScoreClass(score, par) {
  const diff = score - par;
  if (diff <= -2) return 'eagle';
  if (diff === -1) return 'birdie';
  if (diff === 0)  return 'par-score';
  if (diff === 1)  return 'bogey';
  return 'double';
}
