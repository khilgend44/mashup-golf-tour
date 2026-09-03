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

### 🟡 P1-3 — Unbounded registration spam + arbitrary season keys (register.js) — ✅ FIXED 2026-09-01
Fixed in code: `season` now must match `^season-\d{1,4}$` (no traversal / arbitrary keys); field length caps (username 40, discordName 60, region/launchMonitor 80, email 120); and **`returning` is computed server-side** from `players:meta`/`players:roster` instead of trusting the client flag — closing the required-field bypass (`returning:true` no longer lets an empty record through for a genuinely new username).
**Rate limiting:** Cloudflare's WAF Rate Limiting Rules turned out to require a paid plan/add-on, so this is instead enforced in-app — `functions/api/_ratelimit.js` tracks requests per `CF-Connecting-IP` in the existing KV namespace (short TTL, read-then-increment) and both `register.js` and `submit-stream.js` reject at **5 requests/minute/IP** with a 429. Not perfectly atomic under a burst (same accepted tradeoff as P1-6 below), but stops the realistic threat (a script hammering the endpoint) at zero cost.
[register.js](functions/api/register.js) has no rate limit, no field-length caps, and takes `season` from the body ([:42](functions/api/register.js#L42)) to form the KV key `registrations:${season}`. Consequences:
- An anonymous user can flood `registrations:season-10` with unlimited fake pending entries (each new username passes the dup-check), burying your real approvals queue and growing one KV value toward the 25 MB limit.
- Arbitrary `season` values let them create unlimited *distinct* `registrations:<anything>` keys — KV namespace pollution.
- No max length on `username`/`region`/`discordName`/`email`/`launchMonitor`, so each record can be padded to bloat storage.
- Client-asserted `returning: true` ([:51](functions/api/register.js#L51)) bypasses the new-player required-field checks — spam entries can carry no data at all.
**Fix:** whitelist `season` against known seasons, cap field lengths (e.g. 100 chars), and rate-limit `/api/register` (see fix above — done in-app via KV, not a Cloudflare WAF rule).

### 🟡 P1-4 — Arbitrary KV key writes (submit-stream.js) — ✅ FIXED 2026-07-02 (via P1-2)
[submit-stream.js:25](functions/api/submit-stream.js#L25) validates only that `players` is a non-empty array and `eventId` is present — neither is checked against real events/roster. Combined with the YouTube-URL requirement the *value* is constrained, but the *keys* (`<eventId>:<player>:<round>`) are attacker-chosen, so KV can be seeded with junk keys under any prefix. Lower impact than P1-3 (KV's 512-byte key cap limits size) but same class: unauthenticated writes with no validation of the referenced entities. **Fix:** validate `eventId` exists and `players` are on that event's roster before writing.

### 🟡 P1-5 — Wildcard CORS on the write endpoints — ✅ FIXED 2026-07-02
**Correction on review:** only `register.js` actually sent `Access-Control-Allow-Origin: *`. `submit-stream.js` sends **no** CORS headers at all, which already blocks cross-origin browser calls (no `Allow-Origin` → the browser refuses to expose the response, and its JSON preflight fails) — so it needed no change. Fixed `register.js` to reflect the request Origin only when it's an allowlisted host (`mashupgolf.com`, `www.mashupgolf.com`, or `*.mashup-golf-tour.pages.dev`), with `Vary: Origin`. Same-origin form submissions are unaffected (same-origin requests don't do CORS at all); a third-party site can no longer POST here from a visitor's browser. Note: CORS only governs browsers — curl/server callers are unaffected by design (that's what the in-app rate limit + input validation cover).
_Original finding:_
Both writes send `Access-Control-Allow-Origin: *` ([register.js:7](functions/api/register.js#L7); submit-stream has no CORS block but also no origin restriction). Any third-party website can invoke `/api/register` and `/api/submit-stream` from a visitor's browser, amplifying P1-1/P1-3/P1-4 into drive-by abuse. For public-by-design writes this is less severe than for authenticated ones, but there's no reason these two need `*`. **Fix:** restrict the write endpoints' CORS to your own origins (mashupgolf.com / pages.dev), or drop CORS entirely since your own pages are same-origin.

### 🟡 P1-6 — Read-modify-write race (register.js) — ✅ FIXED 2026-09-03
Not just theoretical — this actually happened in production: a registration (Magic, Season 10) was silently dropped after its Discord "new registration" ping had already fired, matching this exact failure mode. Fixed exactly as originally suggested: registrations now live one per KV key (`registrations:<season>:<lowercaseUsername>:<id>`) instead of a shared JSON-array list, listed by prefix. Concurrent registrations write to independent keys and can no longer collide. `admin/api/registrations.js`'s GET auto-migrates any data still under the old shared-list key the first time it's called for a season (then deletes that key); `register.js`/`registration-check.js`/`approval-digest.js` were all updated to read the new per-key scheme (the last one was reading the shared-list key directly too and would have silently gone permanently blind once the migration deleted it — caught while fixing this).
_Original finding:_ [register.js:71-88](functions/api/register.js#L71-L88) does get-list → push → put with no atomicity. Two registrations landing within the same window → last write wins, silently dropping one. Reliability more than security, but worth noting given P1-3 could induce concurrency. **Fix:** acceptable for low volume; if hardened, move to per-registration keys (`registrations:<season>:<id>`) and list by prefix.

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

---

## Phase 2 — Admin auth chain (2026-07-02)

Scope: every endpoint under `functions/admin/api/*` and the shared guard in `_lib.js` — does each write actually enforce auth, is the JWT verification sound, and is there any way to reach a handler without passing `requireAccess`?

**Verdict: the auth chain is strong.** Findings below are one cleanup + defense-in-depth hardening, not holes.

### Clean / verified
- **Every admin data handler enforces auth.** All 8 files (`events`, `players`, `seasons`, `announce`, `league-alert`, `player-meta`, `registrations`, `inspect-rounds`) call `requireAccess` at the top of every `onRequestGet`/`onRequestPost` **and** immediately `if (denied) return denied;`. No handler calls it without returning. ✅
- **No catch-all handler** in `functions/admin/api/` that could skip the guard (the only `onRequest` is `_middleware.js`, the custom-domain→pages.dev redirect). ✅
- **JWT verification resists algorithm confusion.** [_lib.js:76-82](functions/admin/api/_lib.js#L76-L82) imports the key as `RSASSA-PKCS1-v1_5`/SHA-256 and verifies with that fixed algorithm — it does **not** trust `header.alg`, so `alg:none` and an HS256 downgrade both fail. It checks `exp`, `iss`, `aud`, and the signature against the team's JWKS. ✅
- **Layered correctly:** Access gate (edge) → `_middleware.js` redirect for non-pages.dev hosts → in-code `requireAccess` header+JWT check. The `Cf-Access-Jwt-Assertion` header can't be spoofed because all traffic transits Cloudflare (no separate origin to hit directly), and Access overwrites client-supplied `Cf-Access-*` headers. ✅
- Public `/api/*` remain read-only; all writes live under `/admin/api/*`. ✅

### 🟡 P2-1 — Debug endpoint `inspect-rounds.js` still in production — ✅ FIXED 2026-07-02
Deleted `functions/admin/api/inspect-rounds.js` (orphan, unreferenced) and updated the ARCHITECTURE.md note. Removes the extra write surface and the URL-driven KV seed foot-gun.
[inspect-rounds.js](functions/admin/api/inspect-rounds.js) is Access-protected, but it's an **orphan** (nothing in the site references it — confirmed by grep) that ARCHITECTURE.md explicitly says to "Remove it once the feature is settled." MashCAP is settled (`handicaps.html` + `counting-events.html` are live). Beyond attack surface, its `?seedMashCap=` / `?seedRounds=` params let an admin **overwrite `players:handicaps` / `players:rounds` straight from a URL** — an accidental-data-corruption foot-gun (a bookmarked/shared debug URL clobbers real handicap data until the next refresh). **Fix:** delete the file and the ARCHITECTURE.md note that references it.

### 🟡 P2-2 — Admin writes: wildcard CORS + no in-code Origin/CSRF check — ✅ FIXED 2026-07-02
Added a centralized Origin check in `requireAccess` ([_lib.js](functions/admin/api/_lib.js)): if an `Origin` header is present and not one of our hosts (`mashupgolf.com`, `www`, `*.mashup-golf-tour.pages.dev`), the request is rejected 403 before any auth/logic — so a cross-origin browser POST can't reach a handler regardless of the Access cookie's SameSite. Same-origin admin UI is unaffected (same-origin GETs omit Origin; same-origin POSTs send our own allowlisted Origin). The response CORS header is left wildcard intentionally — harmless without `Allow-Credentials`, and the Origin guard is the substantive control. Covers all 8 admin endpoints at once.
[_lib.js:16-20](functions/admin/api/_lib.js#L16-L20) sets `Access-Control-Allow-Origin: *` (no `Allow-Credentials`) and no endpoint checks the request `Origin`. CSRF protection thus rests **entirely** on Cloudflare Access and the `CF_Authorization` cookie's `SameSite` attribute (Cloudflare-managed, not verifiable from code). If that cookie is ever `SameSite=None`, a logged-in admin who visits a malicious page could have a state-changing POST forwarded through Access (which injects the JWT header) and executed — the attacker can't *read* the response (wildcard CORS without credentials blocks that), but the **write still lands**. **Fix (defense-in-depth, cheap):** add an Origin allowlist check to admin writes (reject cross-origin POSTs), mirroring the P1-5 pattern. The admin UI is same-origin, so this breaks nothing and removes the dependency on Cloudflare's cookie config.

### 🔵 P2-3 — JWKS cache doesn't refresh on an unknown `kid` (availability)
[_lib.js:88-96](functions/admin/api/_lib.js#L88-L96) refetches the signing keys only when the cache is >1h old. When Cloudflare rotates its Access signing key, a **valid** token carrying the new `kid` is rejected (key not in cache) for up to an hour → admin lockout. Not a security hole (fails closed), but an availability nick. **Fix:** on `kid` not found, force one cache refresh before giving up.

### 🔵 P2-4 — JWT with no `exp` is accepted
[_lib.js:68](functions/admin/api/_lib.js#L68) is `if (payload.exp && payload.exp < now)` — a token **lacking** `exp` skips the expiry check (and there's no `nbf` check). Cloudflare Access always issues `exp`, so this is theoretical, but a belt-and-suspenders verifier should require `exp` to be present. **Fix:** reject tokens missing `exp`.

### Suggested Phase 2 priority
1. **P2-1** — delete the orphan debug endpoint (removes surface + a data-corruption foot-gun; one file).
2. **P2-2** — add an Origin check to admin writes (defense-in-depth against CSRF).
3. P2-3 / P2-4 — minor `_lib.js` hardening; batch together.

---

### Suggested fix priority if actioning Phase 1
1. P1-1 (`allowed_mentions`) — one-line change each, closes a live mass-ping vector.
2. P1-2 / P1-4 — validate event + player ownership in submit-stream.
3. ~~P1-3 — season whitelist + length caps + rate limiting on `/api/register`.~~ Done.
4. P1-5 — tighten CORS on the two writes.
