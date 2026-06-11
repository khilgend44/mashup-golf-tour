export function applyFormat(scorecards, format, event = null) {
  switch (format.type) {
    case 'ringer':          return calcRinger(scorecards, format);
    case 'escalator-doom':  return calcEscalatorDoom(scorecards, format, event);
    case 'lone-ranger':     return calcLoneRanger(scorecards, format, event);
    case 'shamble-2man':      return calcShamble2Man(scorecards, format, event);
    case 'nassau-2man':       return calcNassau2Man(scorecards, format, event);
    case 'best2-worst2-all3': return calcBest2Worst2All3(scorecards, format, event);
    case 'devils-draw':           return calcDevilsDraw(scorecards, format, event);
    case 'stableford-3man':       return calcStableford3Man(scorecards, format, event);
    case 'devils-draw-4man':  return calcDevilsDraw4Man(scorecards, format, event);
    default: throw new Error(`Unknown format: ${format.type}`);
  }
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
  const raw = sgtFields.filter(p => p);
  if (raw.length > 0) return { key: raw.map(p => p.toLowerCase()).sort().join('|'), displayMembers: raw, fromKv: false };
  const kv = kvTeamMap?.[card.player_name.toLowerCase()];
  if (kv) return { key: kv.key, displayMembers: kv.displayMembers, fromKv: true };
  return { key: '', displayMembers: [], fromKv: false };
}

// ─── Solo Ringer ────────────────────────────────────────────────────────────

function calcRinger(scorecards, format) {
  const basis = format.scoringBasis;
  const players = {};

  for (const card of scorecards) {
    if (card.status !== 'Completed') continue;
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
    players[name].rounds.push({
      round: card.round,
      net: scores,
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

  results.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.totalNetAllRounds !== b.totalNetAllRounds) return a.totalNetAllRounds - b.totalNetAllRounds;
    return indexCountback(a, b);
  });

  for (let i = 0; i < results.length; i++) {
    if (i > 0) {
      const prev = results[i - 1], curr = results[i];
      const trulyTied = curr.total === prev.total &&
        curr.totalNetAllRounds === prev.totalNetAllRounds &&
        indexCountback(curr, prev) === 0;
      curr.position = trulyTied ? prev.position : i + 1;
      if (trulyTied) { curr.tied = true; prev.tied = true; }
    } else results[0].position = 1;
  }
  return results;
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
    if (card.status === 'Completed') cardsByPlayer[card.player_name.toLowerCase()] = card;
  }

  const kvTeamMap = buildKvTeamMap(event);

  // Group players by team using TeamPlayer fields (fallback: KV event.teams)
  const teams = {};
  for (const card of scorecards) {
    if (card.status !== 'Completed') continue;
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

  // Apply substitutions from event config
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

  // Score each team
  const results = Object.values(teams).map(team => {
    const adjPars = team.pars.map((p, i) => i < 6 ? p : i < 12 ? p * 2 : p * 3);

    const countingPlayers = [];   // countingPlayers[hole][playerIdx] = true/false
    const teamHoleScores = Array.from({ length: 18 }, (_, h) => {
      const ranked = team.players
        .map((p, idx) => ({ idx, score: p.net[h] }))
        .sort((a, b) => a.score - b.score);
      const countN = h < 6 ? 1 : h < 12 ? 2 : team.players.length;
      const counting = new Array(team.players.length).fill(false);
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

  // Sort: team total → net aggregate tiebreaker
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
    if (card.status !== 'Completed') continue;
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
    if (card.status !== 'Completed') continue;
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
    if (card.status !== 'Completed') continue;
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
    if (card.status !== 'Completed') continue;
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

// ─── 2-Man Shamble ──────────────────────────────────────────────────────────

function calcShamble2Man(scorecards, format, event) {
  const kvTeamMap = buildKvTeamMap(event);
  const teams = {};
  for (const card of scorecards) {
    if (card.status !== 'Completed') continue;
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
    if (card.status !== 'Completed') continue;
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
    if (card.status === 'Completed') cardsByPlayer[card.player_name.toLowerCase()] = card;
  }

  const kvTeamMap = buildKvTeamMap(event);

  const teams = {};
  for (const card of scorecards) {
    if (card.status !== 'Completed') continue;
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
