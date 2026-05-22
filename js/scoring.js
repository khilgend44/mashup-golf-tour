export function applyFormat(scorecards, format, event = null) {
  switch (format.type) {
    case 'ringer':          return calcRinger(scorecards, format);
    case 'escalator-doom':  return calcEscalatorDoom(scorecards, format, event);
    default: throw new Error(`Unknown format: ${format.type}`);
  }
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
      };
    }
    players[name].roundsPlayed++;
    players[name].totalNetAllRounds += card.total_net;
    const scores = Array.from({ length: 18 }, (_, i) => card[`hole${i + 1}_${basis}`]);
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
    return {
      isTeam: false,
      player_name: p.player_name,
      ringerCard: card,
      ringerRound: p.ringerRound,
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

  // Group players by team using TeamPlayer fields
  const teams = {};
  for (const card of scorecards) {
    if (card.status !== 'Completed') continue;
    const rawMembers = [card.TeamPlayer1, card.TeamPlayer2, card.TeamPlayer3].filter(p => p);
    const key = rawMembers.map(p => p.toLowerCase()).sort().join('|');
    if (!teams[key]) {
      teams[key] = {
        displayMembers: [...rawMembers],
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

// ─── Payouts ────────────────────────────────────────────────────────────────

// Manual payouts: { place, player, amount } — matched case-insensitively.
// Auto payouts:   { place, amount }         — assigned by position, split on ties.
export function applyPayouts(results, payouts) {
  if (!payouts || !payouts.length) return;

  if (payouts.some(p => p.player)) {
    const map = {};
    for (const p of payouts) if (p.player) map[p.player.toLowerCase()] = p.amount;
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
    const amountMap = Object.fromEntries(payouts.map(p => [p.place, p.amount]));
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
