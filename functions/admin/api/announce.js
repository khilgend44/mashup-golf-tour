// Protected admin endpoint that posts an event announcement (poster + text) to
// Discord.  Route: /admin/api/announce
import { CORS, requireAccess } from './_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const webhookUrl = env.DISCORD_ANNOUNCE_WEBHOOK_URL;
  if (!webhookUrl) {
    return Response.json({ error: 'DISCORD_ANNOUNCE_WEBHOOK_URL not configured in environment' }, { status: 500, headers: CORS });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }

  const { message, imageBase64 } = body;
  if (!imageBase64) {
    return Response.json({ error: 'Missing imageBase64' }, { status: 400, headers: CORS });
  }

  try {
    const binaryStr = atob(imageBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'mashup-announcement.png');
    form.append('payload_json', JSON.stringify({ content: message || '' }));

    const res = await fetch(webhookUrl, { method: 'POST', body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json(
        { error: `Discord returned ${res.status}: ${err.message || 'Unknown error'}` },
        { status: 502, headers: CORS }
      );
    }

    return Response.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
