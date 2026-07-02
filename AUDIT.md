# Security & Architecture Audit

Findings-only log. Severity: 🔴 fix now · 🟡 should fix · 🔵 note/low. Each phase appends; fixes are tracked separately once you decide which to action.

Phases: (1) Public write surface ✅ · (2) Admin auth chain · (3) PII & data leakage · (4) Frontend injection (XSS) · (5) Infra & credentials · (6) Architecture/resilience.

---

## Phase 1 — Public write surface (2026-07-02)

Scope: everything reachable without auth under `functions/api/*` — the two by-design public writes (`register.js`, `submit-stream.js`) plus every public read that carries a KV-write-capable token. Question asked of each: what can an anonymous internet user cause — spam, KV pollution, Discord abuse, overwriting other people's data, info disclosure?

### 🔴 P1-1 — Discord mention injection via `@everyone` (submit-stream.js, register.js) — ✅ FIXED & VERIFIED 2026-07-02
**Verified in prod (commit 2d8d6da):** posted a self-mention `<@id>` via `/api/submit-stream`; the mention rendered as a chip but delivered **no notification/ping**, confirming `allowed_mentions:{parse:[]}` suppresses pings. (Note: user-ID mentions still render visually — `allowed_mentions` controls notification, not rendering; only `@everyone`/`@here` also change appearance to plain text.)
Attacker-controlled text is interpolated straight into a Discord webhook `content` string with **no `allowed_mentions`**, so Discord parses any mentions in it.
- [submit-stream.js:61](functions/api/submit-stream.js#L61) and [:71](functions/api/submit-stream.js#L71) — `players` / `eventName` are user input; webhook is always configured, so this is **live in production**. Submitting a stream with a player name or event name of `@everyone` (or `@here`, or `<@&roleid>`) mass-pings the streams channel.
- [register.js:96](functions/api/register.js#L96) — same pattern with `username`/`region`; only fires if `DISCORD_REGISTER_WEBHOOK_URL` is set (currently optional/unset), so latent.
- Contrast [league-alert.js](functions/admin/api/league-alert.js) which correctly sends `allowed_mentions: { parse: ['users'] }`. **Fix:** add `allowed_mentions: { parse: [] }` (streams/register posts don't need to ping anyone) to both webhook calls.

### 🔴 P1-2 — Stream hijacking: no ownership check (submit-stream.js) — ✅ MITIGATED 2026-07-02
**Chosen approach: validate + alert on overwrite** (no player login exists, so true prevention isn't possible without per-player secrets — accepted). Implemented: reject submissions whose `eventId` isn't a known non-completed event in `admin:events`, reject player names not on `players:roster` or the event's draw, and post a Discord ⚠️ alert whenever a submission *replaces* an already-stored link (with was/now URLs). Legit self-service (fixing your own link) still works, just visibly. Residual risk: a league member can still overwrite another's link — but it now always alerts the channel. **This also closes P1-4** (eventId + player names are now validated before any KV write).
[submit-stream.js:52-65](functions/api/submit-stream.js#L52-L65) writes `${eventId}:${player}:${round}` for whatever `players`/`eventId` the request names. Nothing verifies the submitter *is* that player or that they're in the event. Anyone who knows an active event ID and a player's SGT name can **overwrite that player's stream URL**. The YouTube regex prevents XSS, but a griefer can repoint a competitor's "live" link to any other YouTube video, or blank-overwrite it. **Fix options:** treat re-submission of an existing key as needing confirmation, log/notify on overwrite, or accept it as low-stakes (small known community) and just document.

### 🟡 P1-3 — Unbounded registration spam + arbitrary season keys (register.js) — ✅ CODE FIXED 2026-07-02 · ⏳ rate-limit rule pending (dashboard)
Fixed in code: `season` now must match `^season-\d{1,4}$` (no traversal / arbitrary keys); field length caps (username 40, discordName 60, region/launchMonitor 80, email 120); and **`returning` is computed server-side** from `players:meta`/`players:roster` instead of trusting the client flag — closing the required-field bypass (`returning:true` no longer lets an empty record through for a genuinely new username).
**Still needs a dashboard step** (can't be done well in a Pages Function): a Cloudflare WAF **Rate limiting rule** on `/api/register` for the volumetric flooding. Suggested: Security → WAF → Rate limiting rules → match `URI Path eq "/api/register"` and method POST → e.g. 5 requests / 1 min per IP → Block. Same rule pattern is worth adding for `/api/submit-stream`.
[register.js](functions/api/register.js) has no rate limit, no field-length caps, and takes `season` from the body ([:42](functions/api/register.js#L42)) to form the KV key `registrations:${season}`. Consequences:
- An anonymous user can flood `registrations:season-10` with unlimited fake pending entries (each new username passes the dup-check), burying your real approvals queue and growing one KV value toward the 25 MB limit.
- Arbitrary `season` values let them create unlimited *distinct* `registrations:<anything>` keys — KV namespace pollution.
- No max length on `username`/`region`/`discordName`/`email`/`launchMonitor`, so each record can be padded to bloat storage.
- Client-asserted `returning: true` ([:51](functions/api/register.js#L51)) bypasses the new-player required-field checks — spam entries can carry no data at all.
**Fix:** whitelist `season` against known seasons, cap field lengths (e.g. 100 chars), and add a Cloudflare rate-limit rule on `/api/register`.

### 🟡 P1-4 — Arbitrary KV key writes (submit-stream.js) — ✅ FIXED 2026-07-02 (via P1-2)
[submit-stream.js:25](functions/api/submit-stream.js#L25) validates only that `players` is a non-empty array and `eventId` is present — neither is checked against real events/roster. Combined with the YouTube-URL requirement the *value* is constrained, but the *keys* (`<eventId>:<player>:<round>`) are attacker-chosen, so KV can be seeded with junk keys under any prefix. Lower impact than P1-3 (KV's 512-byte key cap limits size) but same class: unauthenticated writes with no validation of the referenced entities. **Fix:** validate `eventId` exists and `players` are on that event's roster before writing.

### 🟡 P1-5 — Wildcard CORS on the write endpoints — ✅ FIXED 2026-07-02
**Correction on review:** only `register.js` actually sent `Access-Control-Allow-Origin: *`. `submit-stream.js` sends **no** CORS headers at all, which already blocks cross-origin browser calls (no `Allow-Origin` → the browser refuses to expose the response, and its JSON preflight fails) — so it needed no change. Fixed `register.js` to reflect the request Origin only when it's an allowlisted host (`mashupgolf.com`, `www.mashupgolf.com`, or `*.mashup-golf-tour.pages.dev`), with `Vary: Origin`. Same-origin form submissions are unaffected (same-origin requests don't do CORS at all); a third-party site can no longer POST here from a visitor's browser. Note: CORS only governs browsers — curl/server callers are unaffected by design (that's what the WAF rate-limit + input validation cover).
_Original finding:_
Both writes send `Access-Control-Allow-Origin: *` ([register.js:7](functions/api/register.js#L7); submit-stream has no CORS block but also no origin restriction). Any third-party website can invoke `/api/register` and `/api/submit-stream` from a visitor's browser, amplifying P1-1/P1-3/P1-4 into drive-by abuse. For public-by-design writes this is less severe than for authenticated ones, but there's no reason these two need `*`. **Fix:** restrict the write endpoints' CORS to your own origins (mashupgolf.com / pages.dev), or drop CORS entirely since your own pages are same-origin.

### 🟡 P1-6 — Read-modify-write race (register.js)
[register.js:71-88](functions/api/register.js#L71-L88) does get-list → push → put with no atomicity. Two registrations landing within the same window → last write wins, silently dropping one. Reliability more than security, but worth noting given P1-3 could induce concurrency. **Fix:** acceptable for low volume; if hardened, move to per-registration keys (`registrations:<season>:<id>`) and list by prefix.

### 🔵 P1-7 — Username enumeration (registration-check.js)
[registration-check.js:43-44](functions/api/registration-check.js#L43-L44) returns only `{ returning, alreadyRegistered }` booleans (good — no PII), but with no rate limit it lets anyone probe arbitrary usernames to learn who is a returning member / already registered. Low impact; the endpoint's design is otherwise correct.

### 🔵 P1-8 — Constrained scrape proxy / mild SSRF (events-admin.js?type=scrape)
[events-admin.js:44](functions/api/events-admin.js#L44) fetches `https://simulatorgolftour.com/tournament/${tournamentId}` with unencoded, unvalidated `tournamentId`. The scheme+host are hard-coded so an attacker can't redirect to another host, but they can use it as an unauthenticated proxy to fetch arbitrary *paths* on simulatorgolftour.com and get parsed output back. Low risk. **Fix:** validate `tournamentId` is numeric and `encodeURIComponent` it.

### Clean / by-design
- **No token leakage:** `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are used server-side only and never appear in any response. ✅
- **`/api/players`** returns roster + handicaps but **not** email or Discord IDs (those are on the protected `/admin/api/players`). ✅
- **`registration-check`** returns booleans only — the max-privacy design holds. ✅
- **YouTube URL regex** blocks script/`javascript:` payloads in stream values. ✅
- **Old write paths closed:** `players.js`, `seasons.js`, `events-admin.js` are read-only; writes correctly moved to `/admin/api/*`. ✅

### Suggested fix priority if actioning Phase 1
1. P1-1 (`allowed_mentions`) — one-line change each, closes a live mass-ping vector.
2. P1-2 / P1-4 — validate event + player ownership in submit-stream.
3. P1-3 — season whitelist + length caps + rate-limit rule on `/api/register`.
4. P1-5 — tighten CORS on the two writes.
