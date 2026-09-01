// Free, in-app substitute for Cloudflare's paid WAF rate-limiting rules.
// Tracks requests per client IP in KV with a short TTL. Not perfectly atomic
// (read-then-increment), so a burst can slip a request or two past the limit
// — an accepted tradeoff here, same class as the read-modify-write race
// already noted for registrations in AUDIT.md (P1-6). Good enough to stop a
// script hammering a public write endpoint, which is the actual threat.
const KV_NAMESPACE_ID = 'a6cbb9bc3e784be88136dbffe9f9796f';

// Returns true if the request is within limit (and records it), false if it
// should be rejected with 429.
export async function checkRateLimit(accountId, apiToken, request, { keyPrefix, limit, windowSeconds }) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${keyPrefix}:${ip}`;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;

  const getRes = await fetch(base, { headers: { Authorization: `Bearer ${apiToken}` } });
  const count = getRes.ok ? (parseInt(await getRes.text(), 10) || 0) : 0;
  if (count >= limit) return false;

  await fetch(`${base}?expiration_ttl=${windowSeconds}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
    body: String(count + 1),
  });
  return true;
}
