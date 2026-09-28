// Public proxy for SGT's own tournament Stats and Long Drive tabs.
// Route: GET /api/sgt-stats?tournamentId=<id>&subtype=<subtype>
//
// Building block for the Event Summary "Event Highlights" cards (Most
// Complete Ball-Striker, Putting Wizard, Long Drive King, Bomb of the Week).
// Unlike Pace of Play, this data isn't tied to Season 10+ MashUp-collected
// data at all — it's scraped live from SGT itself, so it works for any
// tournament on their platform, past or present.
//
// SGT gates these internal AJAX fragments behind a PHPSESSID cookie — same
// two-step dance .github/workflows/fetch-scorecards.yml already uses for
// CTP: load the tournament page first to mint a session cookie, then pass
// it along with the AJAX headers SGT's own frontend sends. That's 2
// subrequests per invocation regardless of `subtype`, well under Cloudflare's
// per-invocation limit — event-summary.html calls this once per category and
// fans the calls out itself from the browser (Promise.all), rather than one
// invocation here looping over every category, which is the same subrequest
// trap get-streams.js and event-pace.js hit earlier.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const STATS_SUBTYPES = new Set([
  'scoringAverage', 'drivingDistance', 'drivingAccuracy', 'greenAccuracy', 'girProx',
  'sandSave', 'scrambling', 'puttsPerRound', 'puttsPerGIR', 'feetPuttsMade',
  'puttMakePct1', 'puttMakePct2', 'puttMakePct3', 'puttMakePct4', 'puttMakePct5',
  'prox10to30', 'prox30to50', 'prox50to100', 'prox100to125', 'prox125to150', 'prox150to175', 'prox175to200', 'prox200to225',
]);

// Full per-player table rows, e.g. <tr data-player-name='toursauce86'>
// <td class='... position ...'>1</td><td class='player ...'>...</td>
// <td class='... total ...'>64.5</td></tr> — ties render as "T1" etc.
function parseStatsTable(html) {
  const rows = [];
  const rowRe = /<tr data-player-name='([^']+)'>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[2];
    const posM = row.match(/class='[^']*\bposition\b[^']*'>\s*([^<]+)</);
    const valM = row.match(/class='[^']*\btotal\b[^']*'>\s*([^<]+)</);
    if (!posM || !valM) continue;
    const pos = parseInt(posM[1].trim().replace(/^T/i, ''), 10);
    const value = parseFloat(valM[1].trim());
    if (Number.isNaN(pos) || Number.isNaN(value)) continue;
    rows.push({ player: m[1], pos, value });
  }
  return rows;
}

// Same round/hole card shape as .github/scripts/parse_ctp.py, but for
// longest-drive yardage instead of closest-to-pin distance. Only
// long-drive-eligible holes appear (par 3s are skipped by SGT itself).
function parseLongDrive(html) {
  const holes = [];
  const roundRe = /<h3[^>]*>ROUND\s+(\d+)<\/h3>([\s\S]*?)(?=<h3[^>]*>ROUND\s+\d+<\/h3>|$)/g;
  let rm;
  while ((rm = roundRe.exec(html))) {
    const round = parseInt(rm[1], 10);
    const holeRe = /<h5[^>]*>HOLE\s+(\d+)<\/h5>\s*<p[^>]*>AVG\s*-\s*([\d.]+)\s*YDS<\/p>([\s\S]*?)(?=<h5[^>]*>HOLE\s+\d+<\/h5>|$)/g;
    let hm;
    while ((hm = holeRe.exec(rm[2]))) {
      const hole = parseInt(hm[1], 10);
      const avgYds = parseFloat(hm[2]);
      const leaderRe = /\/profile\/[^']+'[^>]*>([^<]+)<\/a>\s*<div[^>]*>([\d.]+)\s*yds<\/div>/g;
      const leaders = [];
      let lm;
      while ((lm = leaderRe.exec(hm[3]))) {
        leaders.push({ player: lm[1].trim(), distanceYds: parseFloat(lm[2]) });
      }
      if (leaders.length) holes.push({ round, hole, avgYds, leaders });
    }
  }
  return holes;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const params = new URL(context.request.url).searchParams;
  const tournamentId = params.get('tournamentId');
  const subtype = params.get('subtype');
  if (!tournamentId || !subtype) {
    return Response.json({ error: 'tournamentId and subtype are required' }, { status: 400, headers: CORS });
  }
  if (subtype !== 'ld' && !STATS_SUBTYPES.has(subtype)) {
    return Response.json({ error: `unknown subtype "${subtype}"` }, { status: 400, headers: CORS });
  }

  try {
    const tourRes = await fetch(`https://simulatorgolftour.com/tournament/${tournamentId}`);
    const sessionCookie = (tourRes.headers.get('set-cookie') || '').split(';')[0];

    const path = subtype === 'ld' ? 'ld' : `stats/${subtype}`;
    const fragRes = await fetch(`https://simulatorgolftour.com/sgt-api/leaderboard/${tournamentId}/${path}`, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `https://simulatorgolftour.com/tournament/${tournamentId}`,
        Cookie: sessionCookie,
      },
    });
    if (!fragRes.ok) return Response.json({ error: `SGT returned ${fragRes.status}` }, { status: 502, headers: CORS });
    const html = await fragRes.text();

    const data = subtype === 'ld' ? { holes: parseLongDrive(html) } : { rows: parseStatsTable(html) };
    // Short CDN cache — this gets called once per category per page view,
    // and the underlying stats only change as new rounds get scraped in.
    return Response.json(data, { headers: { ...CORS, 'Cache-Control': 'public, max-age=120' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
