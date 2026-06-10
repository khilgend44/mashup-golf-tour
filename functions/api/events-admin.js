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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  const params = new URL(request.url).searchParams;
  const type = params.get('type');

  // ── Scrape full event metadata from SGT page ─────────────
  if (type === 'scrape') {
    const tournamentId = params.get('tournamentId');
    if (!tournamentId) return Response.json({ error: 'Missing tournamentId' }, { status: 400, headers: CORS });
    try {
      const sgtRes = await fetch(`https://simulatorgolftour.com/tournament/${tournamentId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!sgtRes.ok) return Response.json({ name: null, error: `SGT returned ${sgtRes.status}` }, { headers: CORS });
      const html = await sgtRes.text();

      const result = { name: null, startDate: null, endDate: null, rounds: [] };

      // ── Name ───────────────────────────────────────────
      const h1Match = html.match(/<h1[^>]*text-sgt-white[^>]*text-uppercase[^>]*>\s*([^<]+)\s*<\/h1>/i);
      if (h1Match) {
        result.name = h1Match[1].trim().replace(/\s+/g, ' ');
      } else {
        const full = html.match(/MASHUP\s+S\d+W\d+\s*[-–]\s*[A-Z0-9][A-Z0-9\s''&-]*/i);
        if (full) result.name = full[0].trim().replace(/\s+/g, ' ');
      }

      // ── Dates ──────────────────────────────────────────
      const MONTHS = { January:'01',February:'02',March:'03',April:'04',May:'05',June:'06',July:'07',August:'08',September:'09',October:'10',November:'11',December:'12' };
      const dateDiv = html.match(/<div class='text-nowrap'>([^<]*(?:January|February|March|April|May|June|July|August|September|October|November|December)[^<]*\d{4}[^<]*)<\/div>/i);
      if (dateDiv) {
        const ds = dateDiv[1].trim();
        let dm = ds.match(/(\w+)\s+(\d+)\s*[-–]\s*(\w+)\s+(\d+),?\s*(\d{4})/);
        if (dm && MONTHS[dm[1]] && MONTHS[dm[3]]) {
          result.startDate = `${dm[5]}-${MONTHS[dm[1]]}-${dm[2].padStart(2,'0')}`;
          result.endDate   = `${dm[5]}-${MONTHS[dm[3]]}-${dm[4].padStart(2,'0')}`;
        } else {
          dm = ds.match(/(\w+)\s+(\d+)\s*[-–]\s*(\d+),?\s*(\d{4})/);
          if (dm && MONTHS[dm[1]]) {
            result.startDate = `${dm[4]}-${MONTHS[dm[1]]}-${dm[2].padStart(2,'0')}`;
            result.endDate   = `${dm[4]}-${MONTHS[dm[1]]}-${dm[3].padStart(2,'0')}`;
          }
        }
      }

      // ── Round settings ─────────────────────────────────
      const roundHeaderRe = /<div class='col-12 col-md-4[^>]*>\s*ROUND\s+(\d+)\s*<\/div>\s*<div class='col-12 col-md-8[^>]*>\s*([^<]+)\s*<\/div>/gi;
      const roundStarts = [];
      let rm;
      while ((rm = roundHeaderRe.exec(html)) !== null) {
        roundStarts.push({ pos: rm.index, end: rm.index + rm[0].length, round: parseInt(rm[1]), course: rm[2].trim() });
      }
      for (let i = 0; i < roundStarts.length; i++) {
        const start = roundStarts[i].end;
        const end   = i + 1 < roundStarts.length ? roundStarts[i + 1].pos : Math.min(start + 5000, html.length);
        const chunk = html.slice(start, end);
        const settings = {};
        const settingRe = /class='[^']*three-quarter-font text-sgt-light mb-1[^']*'>\s*([^<]+)\s*<\/div>\s*<div class='[^']*three-quarter-font text-sgt-light text-uppercase[^']*'>\s*([^<]+)\s*<\/div>/gi;
        let sm;
        while ((sm = settingRe.exec(chunk)) !== null) {
          settings[sm[1].trim().toUpperCase()] = sm[2].trim();
        }
        result.rounds.push({
          round:    roundStarts[i].round,
          course:   roundStarts[i].course,
          stimp:    settings.STIMP    ? parseFloat(settings.STIMP)  : null,
          fairways: settings.FAIRWAYS || null,
          greens:   settings.GREENS   || null,
          tees:     settings.TEES     || null,
          slope:    settings.SLOPE    ? parseInt(settings.SLOPE)    : null,
          rating:   settings.RATING   ? parseFloat(settings.RATING) : null,
          pins:     settings.PINS     || null,
          weather:  settings.WEATHER  || null,
          wind:     settings.WIND     || null,
          gimmies:  settings.GIMMIES  || null,
          putting:  settings.PUTTING  || null,
        });
      }

      return Response.json(result, { headers: CORS });
    } catch (e) {
      return Response.json({ name: null, error: e.message }, { headers: CORS });
    }
  }

  try {
    const [eventsRaw, formatsRaw] = await Promise.all([
      type !== 'formats' ? kvGet(accountId, apiToken, 'admin:events')  : Promise.resolve(null),
      type !== 'events'  ? kvGet(accountId, apiToken, 'admin:formats') : Promise.resolve(null),
    ]);

    if (type === 'events')  return Response.json(eventsRaw  ? JSON.parse(eventsRaw)  : [],  { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    if (type === 'formats') return Response.json(formatsRaw ? JSON.parse(formatsRaw) : {},  { headers: { ...CORS, 'Cache-Control': 'no-store' } });

    return Response.json({
      events:  eventsRaw  ? JSON.parse(eventsRaw)  : [],
      formats: formatsRaw ? JSON.parse(formatsRaw) : {},
    }, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return Response.json({ error: 'Missing credentials' }, { status: 500, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS }); }

  const { action } = body;

  // ── Events ──────────────────────────────────────────────────
  if (action === 'create-event') {
    const { event } = body;
    if (!event || !event.id) return Response.json({ error: 'Missing event data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    if (events.find(e => e.id === event.id))
      return Response.json({ error: `Event ${event.id} already exists` }, { status: 409, headers: CORS });
    events.push(event);
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event }, { headers: CORS });
  }

  if (action === 'update-event') {
    const { event } = body;
    if (!event || !event.id) return Response.json({ error: 'Missing event data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === event.id);
    if (idx === -1) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });
    events[idx] = event;
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    return Response.json({ ok: true, event }, { headers: CORS });
  }

  if (action === 'activate-event') {
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const idx = events.findIndex(e => e.id === eventId);
    if (idx === -1) return Response.json({ error: 'Event not found' }, { status: 404, headers: CORS });
    if (events[idx].status === 'active') return Response.json({ error: 'Event is already active' }, { status: 409, headers: CORS });
    events[idx] = { ...events[idx], status: 'active' };
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(events));
    // Snapshot current handicaps for this event
    const handicapsRaw = await kvGet(accountId, apiToken, 'players:handicaps');
    if (handicapsRaw) {
      await kvPut(accountId, apiToken, `${eventId}:handicaps`, handicapsRaw);
    }
    return Response.json({ ok: true, event: events[idx] }, { headers: CORS });
  }

  if (action === 'delete-event') {
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:events');
    const events = raw ? JSON.parse(raw) : [];
    const updated = events.filter(e => e.id !== eventId);
    await kvPut(accountId, apiToken, 'admin:events', JSON.stringify(updated));
    return Response.json({ ok: true }, { headers: CORS });
  }

  // ── Formats ─────────────────────────────────────────────────
  if (action === 'create-format') {
    const { format } = body;
    if (!format || !format.id) return Response.json({ error: 'Missing format data' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:formats');
    const formats = raw ? JSON.parse(raw) : {};
    formats[format.id] = format;
    await kvPut(accountId, apiToken, 'admin:formats', JSON.stringify(formats));
    return Response.json({ ok: true, format }, { headers: CORS });
  }

  if (action === 'delete-format') {
    const { formatId } = body;
    if (!formatId) return Response.json({ error: 'Missing formatId' }, { status: 400, headers: CORS });
    const raw = await kvGet(accountId, apiToken, 'admin:formats');
    const formats = raw ? JSON.parse(raw) : {};
    delete formats[formatId];
    await kvPut(accountId, apiToken, 'admin:formats', JSON.stringify(formats));
    return Response.json({ ok: true }, { headers: CORS });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: CORS });
}
