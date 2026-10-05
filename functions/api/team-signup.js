// Public 2-man team self-signup, keyed by season + week (not event id — the
// real event may not exist yet, e.g. S10W5 before a course is picked).
// Route: GET/POST /api/team-signup
//
// Model: one JSON blob per season+week, read-modify-write (same low-traffic
// tradeoff as admin:events / admin:seasons elsewhere in this codebase — no
// locking, acceptable for a small league signing up by hand).
//   { pairs: [{ players: [a, b], at }], solo: [{ player, at }] }
//
// Once two players are in `pairs`, both become unpickable everywhere (locked
// per the league owner's explicit requirement). A `solo` entry is NOT locked
// — it's actively looking for a partner, so it stays visible and pickable
// until it's absorbed into a pair or withdrawn.
import { checkRateLimit } from './_ratelimit.js';
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvGet(accountId, apiToken, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) return null;
  return res.text();
}

async function kvPut(accountId, apiToken, key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put failed: ${res.status}`);
}

function parseSeasonWeek(seasonRaw, weekRaw) {
  const season = String(seasonRaw || '');
  const week = parseInt(weekRaw, 10);
  if (!/^season-\d{1,4}$/.test(season)) return null;
  if (!Number.isInteger(week) || week < 1 || week > 50) return null;
  return { season, week };
}

async function loadState(accountId, apiToken, season, week) {
  const raw = await kvGet(accountId, apiToken, `team-signup:${season}:${week}`);
  if (!raw) return { pairs: [], solo: [] };
  try {
    const parsed = JSON.parse(raw);
    return { pairs: Array.isArray(parsed.pairs) ? parsed.pairs : [], solo: Array.isArray(parsed.solo) ? parsed.solo : [] };
  } catch {
    return { pairs: [], solo: [] };
  }
}

async function saveState(accountId, apiToken, season, week, data) {
  await kvPut(accountId, apiToken, `team-signup:${season}:${week}`, JSON.stringify(data));
}

async function notify(env, content) {
  const webhookUrl = env.DISCORD_STREAMS_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
  } catch { /* best-effort */ }
}

// Finds a roster name case-insensitively and returns its canonical casing.
function resolveRosterName(roster, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return roster.find(n => n.toLowerCase() === needle) || null;
}

function findEntry(data, name) {
  const lower = name.toLowerCase();
  const pair = data.pairs.find(p => p.players.some(n => n.toLowerCase() === lower));
  if (pair) return { type: 'pair', entry: pair };
  const solo = data.solo.find(s => s.player.toLowerCase() === lower);
  if (solo) return { type: 'solo', entry: solo };
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Storage not configured' }, { status: 500, headers: CORS });

  const params = new URL(request.url).searchParams;
  const sw = parseSeasonWeek(params.get('season'), params.get('week'));
  if (!sw) return Response.json({ error: 'Invalid season/week' }, { status: 400, headers: CORS });

  try {
    const [data, seasonsRaw] = await Promise.all([
      loadState(accountId, apiToken, sw.season, sw.week),
      kvGet(accountId, apiToken, 'admin:seasons'),
    ]);
    const seasons = seasonsRaw ? JSON.parse(seasonsRaw) : [];
    const seasonObj = seasons.find(s => s.id === sw.season);
    const roster = seasonObj?.players || [];
    return Response.json({ ...data, roster }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const json = (obj, status = 200) => Response.json(obj, { status, headers: CORS });

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return json({ error: 'Storage not configured' }, 500);

  const withinLimit = await checkRateLimit(accountId, apiToken, request, { keyPrefix: 'ratelimit:team-signup', limit: 10, windowSeconds: 60 });
  if (!withinLimit) return json({ error: 'Too many attempts. Please wait a minute and try again.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const sw = parseSeasonWeek(body.season, body.week);
  if (!sw) return json({ error: 'Invalid season/week' }, 400);
  const { season, week } = sw;

  const action = String(body.action || '');
  if (!['pair', 'solo', 'withdraw'].includes(action)) return json({ error: 'Invalid action' }, 400);

  let seasonsRaw;
  try {
    seasonsRaw = await kvGet(accountId, apiToken, 'admin:seasons');
  } catch {
    return json({ error: 'Could not verify season' }, 502);
  }
  const seasons = seasonsRaw ? JSON.parse(seasonsRaw) : [];
  const seasonObj = seasons.find(s => s.id === season);
  if (!seasonObj) return json({ error: 'Unknown season' }, 404);
  const roster = seasonObj.players || [];

  try {
    const data = await loadState(accountId, apiToken, season, week);

    if (action === 'pair') {
      const playerName  = resolveRosterName(roster, body.player);
      const partnerName = resolveRosterName(roster, body.partner);
      if (!playerName)  return json({ error: `Unknown player: ${body.player || ''}` }, 400);
      if (!partnerName) return json({ error: `Unknown player: ${body.partner || ''}` }, 400);
      if (playerName.toLowerCase() === partnerName.toLowerCase()) return json({ error: 'Pick two different players.' }, 400);

      const playerTaken  = data.pairs.find(p => p.players.some(n => n.toLowerCase() === playerName.toLowerCase()));
      if (playerTaken) return json({ error: `${playerName} is already paired up.` }, 409);
      const partnerTaken = data.pairs.find(p => p.players.some(n => n.toLowerCase() === partnerName.toLowerCase()));
      if (partnerTaken) return json({ error: `${partnerName} is already paired up.` }, 409);

      // A locked-in pair absorbs either player's "looking for partner" entry.
      data.solo = data.solo.filter(s =>
        s.player.toLowerCase() !== playerName.toLowerCase() &&
        s.player.toLowerCase() !== partnerName.toLowerCase());

      data.pairs.push({ players: [playerName, partnerName], at: new Date().toISOString() });
      await saveState(accountId, apiToken, season, week, data);
      await notify(env, `⛳ **${playerName}** + **${partnerName}** locked in a pair for Season ${season.replace('season-', '')} Week ${week}`);
      return json({ ok: true, ...data });
    }

    if (action === 'solo') {
      const playerName = resolveRosterName(roster, body.player);
      if (!playerName) return json({ error: `Unknown player: ${body.player || ''}` }, 400);

      const taken = data.pairs.find(p => p.players.some(n => n.toLowerCase() === playerName.toLowerCase()));
      if (taken) return json({ error: `${playerName} is already paired up — withdraw first if you want a new partner.` }, 409);

      const already = data.solo.some(s => s.player.toLowerCase() === playerName.toLowerCase());
      if (!already) {
        data.solo.push({ player: playerName, at: new Date().toISOString() });
        await saveState(accountId, apiToken, season, week, data);
        await notify(env, `🙋 **${playerName}** is looking for a partner for Season ${season.replace('season-', '')} Week ${week}`);
      }
      return json({ ok: true, ...data });
    }

    // withdraw
    const playerName = resolveRosterName(roster, body.player);
    if (!playerName) return json({ error: `Unknown player: ${body.player || ''}` }, 400);

    const found = findEntry(data, playerName);
    if (!found) return json({ error: `${playerName} doesn't have an active signup.` }, 404);

    if (found.type === 'pair') {
      const other = found.entry.players.find(n => n.toLowerCase() !== playerName.toLowerCase());
      data.pairs = data.pairs.filter(p => p !== found.entry);
      await saveState(accountId, apiToken, season, week, data);
      await notify(env, `⚠️ **${playerName}** withdrew from their pair with **${other}** (Season ${season.replace('season-', '')} Week ${week}) — ${other}, you're free to sign up again`);
    } else {
      data.solo = data.solo.filter(s => s !== found.entry);
      await saveState(accountId, apiToken, season, week, data);
      await notify(env, `${playerName} is no longer looking for a partner (Season ${season.replace('season-', '')} Week ${week})`);
    }
    return json({ ok: true, ...data });
  } catch (e) {
    return json({ error: `Storage error: ${e.message}` }, 502);
  }
}
