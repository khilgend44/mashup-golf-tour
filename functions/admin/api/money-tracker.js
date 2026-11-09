// Protected admin endpoint for the Admin Money Tracker — a running ledger of
// admin-fee income and spending across every season, independent of player
// dues/payouts (those track money moving between the league and individual
// players; this tracks the league's own operating fund). Route:
// /admin/api/money-tracker
//
// Storage: one KV blob, `admin:money-tracker` -> { entries: [...] }. Same
// one-blob-for-everything shape as admin:events/admin:schedule — accepted
// read-modify-write tradeoff for a page an admin edits rarely, not every
// player's own write like dues/payouts/registrations (which split into
// one-key-per-record specifically to avoid that race).
//
// Two entry kinds, both flat in the same `entries` array:
//   - 'season':     { id, kind:'season', label, players, feePerPlayer, easterEgg, evictedFees }
//                    net = players*feePerPlayer - easterEgg - evictedFees
//   - 'adjustment': { id, kind:'adjustment', label, amount, note }
//                    net = amount (sign included - a donation OUT is negative)
// The running "Admin Fee Bank" total is just the sum of every entry's net -
// computed client-side from the full list, not stored separately, so it's
// never out of sync with the entries themselves.
import { CORS, kvGet, kvPut, requireAccess } from './_lib.js';

const KEY = 'admin:money-tracker';

function newId() {
  return `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeEntry(body) {
  const kind = body.kind === 'adjustment' ? 'adjustment' : 'season';
  const label = String(body.label || '').trim();
  if (!label) return null;
  if (kind === 'season') {
    return {
      kind, label,
      players: Number(body.players) || 0,
      feePerPlayer: Number(body.feePerPlayer) || 0,
      easterEgg: Number(body.easterEgg) || 0,
      evictedFees: Number(body.evictedFees) || 0,
    };
  }
  return {
    kind, label,
    amount: Number(body.amount) || 0,
    note: String(body.note || '').trim(),
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  const raw = await kvGet(accountId, apiToken, KEY);
  const entries = raw ? (JSON.parse(raw).entries || []) : [];
  return Response.json({ entries }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = await requireAccess(request, env);
  if (denied) return denied;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const raw = await kvGet(accountId, apiToken, KEY);
  const data = raw ? JSON.parse(raw) : { entries: [] };
  const entries = Array.isArray(data.entries) ? data.entries : [];

  if (body.action === 'add-entry') {
    const clean = sanitizeEntry(body.entry || {});
    if (!clean) return Response.json({ error: 'label required' }, { status: 400, headers: CORS });
    const entry = { id: newId(), ...clean, createdAt: new Date().toISOString() };
    entries.push(entry);
    await kvPut(accountId, apiToken, KEY, JSON.stringify({ entries }));
    return Response.json({ ok: true, entry, entries }, { headers: CORS });
  }

  if (body.action === 'add-entries') {
    // Bulk import (the one-time historical seed) - same validation per row,
    // one KV write for the whole batch instead of N round trips.
    const list = Array.isArray(body.entries) ? body.entries : [];
    const added = [];
    for (const raw of list) {
      const clean = sanitizeEntry(raw);
      if (!clean) continue;
      const entry = { id: newId(), ...clean, createdAt: new Date().toISOString() };
      entries.push(entry);
      added.push(entry);
    }
    await kvPut(accountId, apiToken, KEY, JSON.stringify({ entries }));
    return Response.json({ ok: true, added, entries }, { headers: CORS });
  }

  if (body.action === 'update-entry') {
    const id = String(body.id || '');
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return Response.json({ error: 'Entry not found' }, { status: 404, headers: CORS });
    const clean = sanitizeEntry(body.entry || {});
    if (!clean) return Response.json({ error: 'label required' }, { status: 400, headers: CORS });
    entries[idx] = { ...entries[idx], ...clean, updatedAt: new Date().toISOString() };
    await kvPut(accountId, apiToken, KEY, JSON.stringify({ entries }));
    return Response.json({ ok: true, entry: entries[idx], entries }, { headers: CORS });
  }

  if (body.action === 'delete-entry') {
    const id = String(body.id || '');
    const next = entries.filter(e => e.id !== id);
    await kvPut(accountId, apiToken, KEY, JSON.stringify({ entries: next }));
    return Response.json({ ok: true, entries: next }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
