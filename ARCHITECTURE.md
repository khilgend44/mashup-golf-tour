# MashUp Golf Tour — Architecture Reference

Last updated: September 1, 2026

---

## How the Site Works (Big Picture)

```
Your Browser
    ↓
Cloudflare Pages  (hosts the website)
    ↓
GitHub Repo  (source of truth for all files)
    ↑
GitHub Actions  (auto-fetches live scorecards every 20 min)
    ↑
Cloudflare Worker  (triggers GitHub Actions on a reliable cron)
    ↑
SimulatorGolfTour API  (provides live scorecard data)
```

---

## Components

### 1. Website Hosting — Cloudflare Pages
- **Custom domain:** https://mashupgolf.com — **registered at Names.com**, but its **nameservers point to Cloudflare** (so DNS records are managed in the Cloudflare dashboard, not Names.com). Bound as a **Custom domain** in the Pages project, which is what wires routing — manually-created CNAMEs alone produce an Error 522.
  - **`www.mashupgolf.com`** is also a bound Pages Custom domain (CNAME `www` → pages.dev, proxied). Both apex and www must exist: Cloudflare Access's auth callback lands on the exact host requested, so if `www` has no DNS record the login dead-ends at `www.mashupgolf.com/cdn-cgi/access/authorized` with "server can't be found." (Also: the zone's negative-cache TTL is ~30 min, so a device that cached an old NXDOMAIN keeps failing until it expires — bust it with airplane-mode/another device.)
- **Pages URL:** https://mashup-golf-tour.pages.dev (always works; use this when the custom domain misbehaves)
- **Repo:** https://github.com/khilgend44/mashup-golf-tour
- Every `git push` to `main` auto-deploys the site within ~1–2 minutes. No manual deploy step.
- **Heads-up (Zscaler):** on corporate network, `mashupgolf.com` is blocked by Zscaler's *"Newly Registered and Observed Domains"* category (the page is fine — Zscaler intercepts before it reaches Cloudflare). Use `pages.dev` on the corporate network, or test from a non-corporate network; the block clears as the domain ages (~30 days) or via an InfoSec allowlist request.
- If a deploy ever seems stuck (rare Cloudflare-side hiccup), an empty commit (`git commit --allow-empty`) re-triggers it.

### 2. Admin Portal — `/admin`
- **URL:** https://mashup-golf-tour.pages.dev/admin
- Protected by **Cloudflare Access** (Google SSO — only approved Google accounts can log in)
- Pages:
  - `/admin/index.html` — portal home. Tiles are grouped into **"This Week's Workflow"** (Events → Players → Teams → Poster, in the order the Guide's Weekly Workflow uses them) and **"Season & Reference"** (Seasons, Registrations, Player Data, League Alert, Formats, Backup, Guide). Above the tiles, a **weekly progress tracker** shows every week of the active season as a breadcrumb (✓ for completed, a live `n/7` fraction for the current week, a dimmed "Not started" pill for one week ahead — added automatically once the latest real week goes `active`, so there's always a running start). The current/upcoming week(s) expand into a 7-item checklist mirroring the Guide's Weekly Workflow steps 1-for-1. Auto-detected items (tournament exists, event exists, teams drawn for team formats, announced/activated, completed) are inferred from event data and can't be toggled; the rest (handicaps refreshed, field set for solo formats, loading file uploaded to SGT) are manual checkboxes with no data trace of their own, persisted to `event.weeklyChecklist` (`{ handicapsRefreshed, fieldSet, loadingFileUploaded }`, all booleans) via `/admin/api/events` `update-event`. Best-effort throughout — any load failure (not signed in, no active season) just leaves the section hidden rather than blocking the portal.
  - `/admin/guide.html` — wiki-style operator's guide (TOC sidebar + scroll-spy): what each portal page does, the weekly workflow, the SGT admin "Game" functions (Reset Player, Delete Save Game, Update Player Resume, Create/Modify Scorecard), and Access/deploy notes. Linked as a card on the portal index. Static content — update it when admin workflows change.
  - `/admin/players.html` — manage player roster, view/refresh handicaps
  - `/admin/registrations.html` — review Season N signups (see **10. Season 10 Registration** below)
  - `/admin/player-data.html` — the persistent player record (name, Discord, email, launch monitor, region, usual pay service) plus a season-scoped **dues tracker**: per season, mark each player Paid, the date, which service they used, and the amount — with a live "X paid · $Y collected" summary. Season selector defaults to the active season. Distinct from the "Pay Service" column, which just records a player's usual payment app, not a specific season's payment status.
  - `/admin/events.html` — create/manage seasons and events
    - SGT Event URL must be entered first — it unlocks the rest of the form and auto-populates event name, dates, rounds, and week number
    - Event name is locked after SGT scrape and does not change when format is changed
    - **Details** button shows a metadata panel (format, payouts, rounds, etc.) for active/completed events
    - **↺ Sync** button re-scrapes SGT to refresh dates and round settings on an existing event
    - **Complete ✓** opens the CTP-winner modal then marks the event completed. The CTP winner picker offers the **full season roster** (unioned with any team members) — a CTP can go to any season player, not just event participants (`eventPlayers()`), for finale/partial-field events
  - `/admin/teams.html` — draw teams for an event (Steps 1–4):
    - Step 1: Create Teams — three modes:
      - **Tiered Draw**: 1 player pulled from each handicap tier, produces balanced teams
      - **Completely Random**: all players shuffled, pure luck
      - **Manual Entry**: click-to-assign UI — select a player chip, click a team slot to place them. Save enables once there's **≥1 full team and no half-filled teams**; only complete teams are saved and leftover players stay unassigned (so finale/partial-field events that don't use the whole roster can be saved)
    - Step 2: Generate SGT Loading File (CSV download for SimulatorGolfTour registration) — uses season-scoped player list
    - Step 3: Upload SGT Loading File (manual instruction — links to SGT Admin)
    - Step 4: Configure Special Team Orders (Lone Ranger slot assignments) — all teams pre-loaded, ▲▼ swap buttons per player, default order A=Slot1/B=Slot2/C=Slot3
  - `/admin/poster-preview.html` — generate and send the weekly event announcement:
    - Visual poster preview (exported as PNG via html2canvas)
    - Discord announcement text (format rules, course settings, prizes)
    - Posts to Discord via `/admin/api/announce`
    - After posting, prompts to activate the event (activation enables live scorecard fetching)
  - `/admin/formats.html` — read-only tile grid of every game format on file (built-in from `data/formats.json` + any custom ones saved to KV): name, team size, scoring basis, description, segments, tiebreakers
  - `/admin/backup.html` — one-click download of a full KV namespace export (see **12. Backup & Disaster Recovery** below)

### 2b. API Endpoints & Security Model
The API is split into **public reads** and **protected writes** so the public site can load data freely while only an authenticated admin can change it.

- **Public reads — `functions/api/*`** (route `/api/*`, no auth):
  - `/api/events-admin?type=events|formats|scrape` — event/format lists + SGT page scrape (GET)
  - `/api/seasons` — season list (GET)
  - `/api/players` — roster + handicaps (GET)
  - `/api/player-rounds` — stored per-round MashCAP data; whole map or `?player=x` (GET)
  - `/api/event-public`, `/api/get-streams` — public event/team + stream data (GET)
  - `/api/submit-stream` — **public write by design** (players submit their own YouTube links); rate-limited (see **10. Season 10 Registration**)
  - `/api/register` — **public write by design** (season signup form); rate-limited
  - `/api/registration-check?username=x&season=y` — returns only `{returning, alreadyRegistered}` booleans, never stored data — lets the form recognize a returning player without a username-enumeration leak
  - `/api/approval-digest` — **not actually public**, despite living under `/api/*`: a scheduler-only endpoint gated by a shared secret rather than Cloudflare Access, since no browser session is involved (see **11. Daily Approval Digest**)
- **Protected writes — `functions/admin/api/*`** (route `/admin/api/*`, behind Cloudflare Access):
  - `/admin/api/events` — create/update/delete/activate/complete event, create/delete format, **`set-devils-draw`** (saves a Devil's Draw `devilsDraw`+`revealOrder` onto a KV event — called by the "Save Draw to Event" button in `event.html?...&reveal=true`)
  - `/admin/api/players` — onboard/add/remove player, refresh handicaps, `set-discord` (map a player to their numeric Discord user ID in `players:discord`, used for `<@id>` mentions in results posts, League Alert, and the approval digest), `check-one` (single-player SGT `player-check` snapshot — rawCap/comboCap/events/connector — used on `admin/registrations.html` to vet a registrant before approving). **Confirmed (2026-09) that `player-check` shares the same ~1-response-per-key-per-24h cache as `player-hcp-rounds`** — a second call within the window silently ignores its `players=` param and replays the first call's result. Since only the first call of the day matters, every `check-one` call rides along with the full Season 9 roster, anyone already approved for the given season, and every other currently-pending registration for that season — so whichever registration's "Check SGT" button happens to fire the day's one real request, every pending registrant that day is still found in the same cached response, not just whoever was clicked first.
  - `/admin/api/seasons` — create/update/archive season
  - `/admin/api/announce` — post event poster to Discord
  - `/admin/api/registrations` — list/approve/decline/reset/delete season registrations; approve upserts `players:meta` (no email) and, if the season exists, chains straight into the roster + season adds (see **10. Season 10 Registration**)
  - `/admin/api/player-meta` — GET/set the persistent player record (`players:meta`); also handles bulk paste-and-import
  - `/admin/api/dues` — GET/set one player's season dues (`dues:<season>:<lowercaseUsername>`, one key per player): paid, date paid, service, amount, carry-over
- Admin pages keep reads on `/api/*` constants (`API`, `PLAYERS_API`) and send writes to `/admin/api/*` constants (`API_WRITE`, `PLAYERS_WRITE`).

**Three layers of protection on every write** (`functions/admin/api/_lib.js` → `requireAccess()`):
1. **Cloudflare Access gate** — `/admin/api/*` sits under `/admin/`, so the same Access application that guards the admin pages blocks unauthenticated requests *before* they reach the function code.
2. **Required auth header** — the function rejects any request lacking the `Cf-Access-Jwt-Assertion` header (Cloudflare only injects this after a request passes the gate).
3. **Cryptographic token verification** — when `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` env vars are present, the function verifies the token's RS256 signature (against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), audience, and expiry. If the env vars are absent it falls back to header-presence only (layer 2).

**Current status:** all three layers are active in production — `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set in Cloudflare Pages env vars. If those vars are ever lost/cleared, writes still hold at layers 1–2.

**Cloudflare Access config (confirmed working):**
- **Admin is gated on `mashup-golf-tour.pages.dev` ONLY** (Destination: pages.dev / path `admin`). ⚠️ **Do NOT add the custom domain (`mashupgolf.com`/`www`) to this Access app** — a shared multi-hostname app makes Access **canonicalize the post-login redirect to the custom domain**, which then hangs behind Zscaler (`mashupgolf.com` is Zscaler-blocked). Instead, `functions/admin/_middleware.js` **redirects any `/admin` request on a non-`pages.dev` host to the pages.dev host**, so the custom-domain admin bounces to the gated host and no admin content is ever served on `mashupgolf.com`. (Access matches on hostname+path; the middleware covers the hostnames Access doesn't. `/admin/api/*` is additionally held by the in-code `requireAccess` header check.)
- **Use `https://mashup-golf-tour.pages.dev/admin` as the admin URL.**
- Path is a **prefix**, so `admin` automatically covers `/admin`, `/admin/api/events`, etc.
- **Policies** tab: allow-policy limited to the owner's Google account.
- If admin writes ever return `403 "admin access required"`, the Access path isn't covering `/admin/api/`. If they return `403 "invalid access token"`, a `CF_ACCESS_*` env var has a wrong value (remove both to fall back to layers 1–2).

**Enabling / re-creating the layer-3 env vars:**
1. Zero Trust → Settings → **team domain** → use `https://<team>.cloudflareaccess.com` (no trailing slash) as `CF_ACCESS_TEAM_DOMAIN`.
2. Zero Trust → Access → Applications → admin app → Overview → **Application Audience (AUD) Tag** → use as `CF_ACCESS_AUD`.
3. Cloudflare Pages → project → Settings → Variables and Secrets (Production) → add both → **Save**, then **Deployments → Retry deployment** (env vars only take effect on a new build).

**Verifying API security (run anytime):**
```bash
B="https://mashup-golf-tour.pages.dev"
curl -s -o /dev/null -w "%{http_code}\n" "$B/api/events-admin?type=events"          # 200  public read works
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/api/events-admin" -d '{}'       # 405  old write path closed
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/admin/api/events" -d '{}'       # 302  anonymous write blocked at gate
```

### 3. Data Storage — Cloudflare KV
- **Namespace ID:** `a6cbb9bc3e784be88136dbffe9f9796f`
- Stores admin-created data that shouldn't be hardcoded in the repo:
  - `admin:events` — events created via admin portal (Season 10+)
  - `admin:formats` — custom game formats created via admin portal (merged with `data/formats.json` at runtime)
  - `players:roster` — player list (names array)
  - `players:handicaps` — handicap data from SGT API (object keyed by lowercase player name → `{ rawCap, comboCap, numEvents, ..., mashCap, mashCapRounds, mashCapCounting }`)
  - `players:rounds` — raw per-round records used for MashCAP, keyed by lowercase player name → `[{ date, differential, tour }]`. Written by the refresh action; served publicly by `/api/player-rounds` for the counting-events detail page.
  - `players:discord` — player → Discord user ID map (lowercase name → numeric ID). Read via the **protected** `GET /admin/api/players` (kept out of the public `/api/players`); edited per-player on the admin Players page. Used to `<@id>`-tag winners in the Discord results post.
  - `players:last_refresh` — ISO timestamp of last handicap pull
  - `players:meta` — persistent, cross-season player record keyed by lowercase username → `{ username, name, launchMonitor, region, discordName, email, payService, creditBalance, updatedAt }`. Distinct from `players:roster` (just names) and `players:handicaps` (SGT/MashCAP numbers) — this is the profile info collected at registration, editable on `admin/player-data.html`. Upserted only when a registration is approved (or edited directly); email here is admin-only (never served publicly). `payService` is the player's *usual* payment app — not tied to any one season's payment (see `dues:<season>` below). `creditBalance` is a manually-maintained running dollar figure for money rolled forward between seasons (e.g. an overpayment intentionally carried to next season) — persists across seasons by design, unlike `dues:<season>`; admins set/clear it by hand, nothing computes it automatically.
  - `registrations:<season>:<lowercaseUsername>:<id>` — **one KV key per registration** (not a shared list): `{ id, username, discordName, launchMonitor, region, email, agreements, returning, changed, status: 'pending'|'approved'|'declined', declineReason, submittedAt, reviewedAt }`. Written by the public `/api/register`; read/mutated only via the protected `/admin/api/registrations`. Originally one shared JSON-array key (`registrations:<season>`) — that had a read-modify-write race (two registrations landing close together could silently clobber each other) that actually lost a real registration in production (2026-09), so it was split into independent per-registration keys. `admin/api/registrations.js`'s GET auto-migrates any leftover data under the old shared-list key the first time it's called for a season, then deletes that key — a one-time, self-healing migration. `register.js` and `registration-check.js` also read that legacy key as a fallback (read-only) in case they're hit in the brief window before the first post-deploy admin GET has migrated a season.
  - `dues:<season>:<lowercaseUsername>` — **one KV key per player per season** (not a shared blob): `{ username, paid: bool, datePaid, service, amount, carryOver, updatedAt }`. Edited per-player on `admin/player-data.html`'s season-scoped Dues columns; resets each season since each key is season-specific. `carryOver` is a permanent, non-editable record of a `creditBalance` that was applied and cleared during this season's collection — the UI prompts to clear the credit balance whenever an Amount is entered for a player who has one, and if confirmed, writes the cleared amount here so it's never lost even though `creditBalance` resets to 0. Admin-only — never exposed publicly. Originally one shared JSON blob per season (`dues:<season>`) — same read-modify-write race as the registrations bug below: checking "Paid" also auto-fills Date Paid in the same click, firing two saves back-to-back, and one could silently clobber the other (confirmed happening in production, 2026-09). `admin/api/dues.js`'s GET auto-migrates any leftover data under the old blob key the first time it's called for a season. The admin page also now queues writes per player client-side (`admin/player-data.html`), so two saves for the same player — dues or `players:meta` — can never run concurrently from one browser tab.
  - `ratelimit:register:<ip>` / `ratelimit:submit-stream:<ip>` — short-lived (60s TTL) request counters for the in-app rate limiter; self-expire, not meant to be read directly.
  - `digest:<season>:lastRun` — ISO timestamp cursor for the daily approval digest (see **11. Daily Approval Digest**); advances every run so the same approval is never announced twice.
  - `{eventId}:{playerName}:{round}` — YouTube stream URLs submitted by players
  - `{eventId}:handicaps` — snapshot of `players:handicaps` taken at the moment an event is activated (used for historical accuracy)
- Static/historical data lives in `data/` JSON files in the repo instead.
- **Adjusted handicap** (used for team draws and posters): `Math.round(rawCap - minRaw)` where `minRaw` is the lowest rawCap among **season-scoped players** (not all-time roster). Always an integer, always ≥ 0.

### 4. Scorecard Automation — GitHub Actions
- **Workflow file:** `.github/workflows/fetch-scorecards.yml`
- Fetches live scorecards from SGT API for **`status == "active"` events only** (upcoming events are skipped)
- Active season is found by merging `data/seasons.json` + `/api/seasons` (KV) — KV takes precedence, so KV-only seasons (e.g. Season 8) are found correctly
- Commits scorecard JSON files to `data/scorecards/{tournamentId}.json`
- Merges both static `data/events.json` and KV-stored events so admin-created events are included
- **Triggered by:** Cloudflare Worker (not GitHub's built-in scheduler — see below)
- **Also fetches closest-to-pin (CTP) standings** in the same run, to `data/ctp/{tournamentId}.json`, read by `fetchCtp()` in `js/api.js` and rendered by `buildCtpLiveHtml()` in `event.html` (a `🎯 Closest to the Pin — Live` section on the event page — distinct from `event.ctp`, the admin-entered final CTP *payout* record added after the event closes). Unlike the scorecards fetch above, **there's no official SGT endpoint for this** — it scrapes the same internal AJAX endpoint (`/sgt-api/leaderboard/{tid}/ctp`) SGT's own tournament page uses for its CTP tab, which needs a fresh session cookie plus `X-Requested-With`/`Referer` headers or it silently returns a generic fallback page instead of data. The HTML response is parsed by `.github/scripts/parse_ctp.py`. Accepted tradeoff: if SGT changes that markup, this degrades to an empty `{"rounds": []}` (section just doesn't render) rather than failing the whole workflow — fix the parser then, no other safety net exists.

### Team Assignment in the Scoring Engine
- All team formats (`js/scoring.js` → `resolveTeamKey`) group players into teams using **`event.teams` (the admin-defined draw, stored in KV) as the authoritative source** whenever it is present.
- **Why KV-first (changed June 2026):** SGT's per-card `TeamPlayer1–4` fields are sometimes returned *incomplete* (one or more slots blank), which fragments a single team into partial teams + solo players. This surfaced on the first 4-man Devil's Draw (S8W6), where the leaderboard showed a mix of 4-man, 3-man, and solo "teams." Preferring the admin draw eliminates it.
- **Fallback to SGT `TeamPlayer1–4`** only when the event has no `event.teams`, or for a player who isn't on any roster team (e.g. a sub) — in which case they're attached to a team via a listed teammate, or grouped by their own SGT fields.
- The Devil's Draw **pre-draw** view (`event.html`) and the **scoring engine** both use this KV-first logic so they agree.
- `event.teams` is an array of arrays of player names: `[['A','B','C'], ['D','E','F'], ...]` — saved by the admin teams page.
- Applies to all team formats: Escalator, Devil's Draw (3-man & 4-man), Stableford, Best2/Worst2, Shamble, Lone Ranger.

### 5. Cron Triggers — Cloudflare Workers
- **`mashup-scorecard-trigger`** — Cloudflare dashboard → Workers & Pages → mashup-scorecard-trigger. Fires every **20 minutes** and calls the GitHub API to trigger the scorecard workflow.
- **`mashup-approval-digest`** — Cloudflare dashboard → Workers & Pages → mashup-approval-digest. Fires **daily at 19:12 UTC** (~3:12pm ET during daylight saving; deliberately off the top of the hour to dodge scheduler congestion — adjust by an hour once DST ends in November if you want to hold the same ET time) and calls `POST /api/approval-digest` directly (with the `X-Cron-Secret` header, from a `DIGEST_CRON_SECRET` secret set on this Worker). Also has a `fetch` handler running the same logic, so visiting the Worker's own URL triggers (and shows the result of) an on-demand run without waiting for the cron — this is also the go-to way to manually re-test it.
- **Why not GitHub's built-in scheduler for either?** GitHub's `schedule` trigger has proven unreliable on this repo for *both* of these — the scorecard fetch needs to run every 20 minutes and GitHub's scheduler skips runs at that frequency, and the approval digest (added 2026-09, originally scheduled via GitHub Actions `cron: '0 14 * * *'`) skipped its scheduled run entirely rather than just running late, so it was moved to a Cloudflare Worker cron too. Cloudflare's cron has been precise for both. The `.github/workflows/approval-digest.yml` file that briefly existed for this was deleted once the Worker was confirmed working — the Worker's `fetch` handler already covers the manual-test case it existed for.
- Like `mashup-scorecard-trigger`, this Worker's source lives only in the Cloudflare dashboard, not in this repo.

### 6. YouTube Stream Submissions
- Players submit their YouTube stream URLs via a form on the site
- **API endpoint:** `functions/api/submit-stream.js`
- Stored in **Cloudflare KV** with key format: `{eventId}:{playerName}:{round}` → YouTube URL
  - Example: `40045:boiler_kh:1` → `https://youtube.com/watch?v=...`
- Supports two modes:
  - **Standard** (up to 4 players sharing one stream URL)
  - **Ringer** (one player, separate Round 1 and Round 2 URLs)
- Also posts a notification to a Discord webhook when a stream is submitted
- Discord webhook URL stored as `DISCORD_STREAMS_WEBHOOK_URL` env var

### 7. Event Announcements (Discord Poster)
- Admin generates a weekly event announcement via `/admin/poster-preview.html`
- **API endpoint:** `functions/api/announce-event.js`
  - Accepts a base64-encoded PNG (the poster) + Discord message text
  - Posts multipart form data to Discord webhook (image + text in one message)
- Discord webhook URL stored as `DISCORD_ANNOUNCE_WEBHOOK_URL` env var

### 8. Public Event Teams Page
- Any event leaderboard (`event.html?id=X`) has a **View Teams** button linking to `event-teams.html?id=X`
- `event-teams.html` is a public read-only page showing the team draw and prizes for an event
- **API endpoint:** `functions/api/event-public.js`
  - Public GET — no Cloudflare Access auth required
  - Returns event data, KV formats, handicaps, and roster for a given event ID
  - Only covers admin-created events (KV-stored, e.g. Season 8/10); Season 9 (static-only, not in `admin:events`) returns 404
- **Handicap columns:** shows both **Raw MashCAP** and **Effective Event MashCAP** per player (team rows and the solo player list both). Re-derives the same `regCap`/allowance/scratch-offset math as `admin/teams.html`'s SGT Loading File and `admin/poster-preview.html` (duplicated inline, not shared — see **Handicap Allowance (per format)**), fetching `/api/seasons` + `/data/seasons.json` itself since `event-public.js`'s `roster` field is the all-time master list, not season-scoped.

### 9. SGT Handicap API
- Pulls player handicap data from SimulatorGolfTour
- Rate-limited to **once per 24 hours**; timestamp stored in `players:last_refresh` KV key
- Triggered manually from the admin Players page ("Refresh Handicaps" button)
- The admin Teams page reads the same `players:last_refresh` timestamp and blocks SGT Loading File generation if handicaps are older than 24 hours
- Two SGT endpoints, both using `player_api_key`:
  - `player-check` — computed SGT caps (`rawCap`, `comboCap`, `numEvents`, …)
  - `player-hcp-rounds` — raw per-round scoring differentials (`{ player, date, differential, tour }`). Also caps at ~1 response per key per 24h and **ignores the `players` param within a window** (returns the first cached result), so it must be pulled in one full-roster call.

### 9b. MashCAP — the league's official handicap
- The league's own handicap, computed during the same "Refresh Handicaps" action from `player-hcp-rounds`.
- **Formula:** average of the best `floor(roundCount × 0.40)` differentials. Round counting rounds **down**; duplicates kept; no minimum round count.
- **Combo-log window cap (48 rounds):** `player-hcp-rounds` returns up to **60** rounds, but SGT's COMBO handicap only counts a player's **most-recent `comboRoundsCount` rounds, which tops out at 48**. So `computeMashCap` sorts each player's rounds newest-first and **trims to their `comboRoundsCount`** (constant `ROUND_CAP_FALLBACK = 48` if that count is missing) *before* taking the best 40% — otherwise high-volume players would get best-40%-of-60 instead of best-40%-of-48, contradicting the public wording "best 40% of the rounds in their SGT Combo log." `roundCount`/`mashCapRounds` therefore reflect the **capped** window, and the trimmed rounds are what get stored to `players:rounds` (so the public table's "Total Events" and the counting-events detail page match exactly). On the roster as of June 2026 this trims 12 high-volume players (60→48, best 24→best 19) and leaves 36 unchanged.
- **Thin-payload safety:** because `player-hcp-rounds` can return a sparse result inside its 24h cache window, the refresh **carries over each player's previously-computed MashCAP** when a pull doesn't cover them, and **always merges** (never replaces) `players:rounds`. A partial refresh can therefore never wipe good handicap data. Core caps (`rawCap`, `comboCap`, …) still come fresh from the reliable `player-check`.
- Stored as `mashCap` (plus `mashCapRounds`, `mashCapCounting`) merged into each player's entry in `players:handicaps`; shown as the far-left **MashCAP** column on the admin Players table (which also sorts by it).
- **MashCAP drives team registration and scoring.** Both the Players and Teams pages use a `regCap(h)` accessor = MashCAP if present, else SGT `rawCap` (fallback only until a player has a MashCAP). The relative handicap written to the SGT Loading File is based on this, run through that event's format handicap allowance first — see **Handicap Allowance (per format)** below. The balanced-team draw tiers use the unmodified `regCap` (raw skill), not the allowance-adjusted number.
- Computed in `computeMashCap()` in `functions/admin/api/players.js`. (A temporary debug inspector at `functions/admin/api/inspect-rounds.js` was removed once MashCAP shipped — it had URL-driven KV seed params that were a data-corruption foot-gun.)
- **Public pages:** `handicaps.html` (season-scoped MashCAP table, linked from the home nav with a "Why MashCAP vs COMBO" explainer; shows a last-updated timestamp from `players:last_refresh`) and `counting-events.html?player=X` (per-player breakdown of every round, sorted newest-first, with the best 40% marked). The latter reads `players:rounds` via the public `/api/player-rounds` endpoint. The refresh action persists those rounds to KV.

### 10. Season 10 Registration
- **Public form:** `registration.html` — SGT username lookup (via `/api/registration-check`) recognizes returning players and shows only what changed; new players fill launch monitor, region, email, Discord name; four required agreements (livestream, OpenAPI ban, handicap/MashCAP, $142 cost). Submits to `/api/register`, which stores a `pending` record as its own KV key under `registrations:<season>:<lowercaseUsername>:<id>` (season hardcoded to `season-10` in the page).
- **No player cap.** Season 10 launched open-enrollment by choice; if it needs to close and a waitlist is added later, that logic goes in `register.js` (a roster-size check) plus new copy/UI in `registration.html`.
- **Admin review:** `admin/registrations.html` — Pending/Approved/Declined/All tabs. **Approve & Add** does the whole thing in one click: prompts for the player's numeric Discord user ID (saved to `players:discord` via `/admin/api/players` `set-discord` — skippable, since the admin doesn't always have it handy), saves the submitted info into `players:meta`, and, if the season exists in KV, immediately adds the player to `players:roster` and the season's roster (all three writes are idempotent, safe to repeat). A standalone **+ Add to Season** button still appears for approved-but-not-yet-added registrations (e.g. ones approved before this existed) as a manual retry path. **Decline** takes a reason and posts it to Discord.
- **Discord pings:** both new-registration and decline-with-reason post to `DISCORD_REGISTER_WEBHOOK_URL` (optional — registrations still save if unset) with `allowed_mentions: { parse: [] }` to prevent mention injection from user-controlled fields.
- **Rate limiting:** Cloudflare's WAF Rate Limiting Rules require a paid plan, so `/api/register` and `/api/submit-stream` are self-limited in-app instead — `functions/api/_ratelimit.js` counts requests per `CF-Connecting-IP` in the existing KV namespace (60s TTL) and rejects with 429 past **5 requests/minute/IP**. Read-then-increment, not perfectly atomic under a burst — an accepted tradeoff, same class as the KV race noted in `AUDIT.md` P1-6.
- **Nav rollout:** all 6 pages with the hamburger nav (`index`, `about`, `requirements`, `rules`, `season`, `event`) list **Season 10** + **Register for Season 10** above a divider, then **Season 9 (Archive)** below it — the pattern to repeat when Season 11 eventually supersedes Season 10.

### 11. Daily Approval Digest (Discord)
Instead of DMing each newly-approved player individually, one digest message per day announces everyone approved since the last run, reusing the **League Alert** webhook (`DISCORD_ANNOUNCE_WEBHOOK_URL`).
- **Endpoint:** `functions/api/approval-digest.js` (route `POST /api/approval-digest`). Finds the active season, lists that season's per-registration keys (`registrations:<season>:*`) + reads `players:discord`, and posts players approved since a per-season cursor (`digest:<season>:lastRun` in KV) — tagging each with a real `<@id>` mention when their Discord ID is on file, else bolding their username. Message ends with a configurable contact line (`DUES_CONTACT_MENTION` env var, e.g. `<@your-discord-id>`) telling them who to DM for payment instructions. Skips posting entirely when there's nothing new; the very first run for a season seeds the cursor silently instead of announcing every already-approved player at once.
- **Not Cloudflare Access-protected** — this endpoint is called by a scheduler, not a signed-in admin, so a browser session isn't available. Instead it's gated by a shared secret: the caller sends `X-Cron-Secret`, checked against the `DIGEST_CRON_SECRET` env var.
- **Trigger:** the `mashup-approval-digest` Cloudflare Worker cron (see **5. Cron Triggers — Cloudflare Workers** above) — a GitHub Actions `schedule` cron was tried first but skipped its runs entirely, the same unreliability already known from the scorecard fetch, so this was moved to Cloudflare's cron like that one. All the actual logic lives in the Pages Function; the Worker just does one `fetch(..., {method:'POST', headers:{'X-Cron-Secret':...}})`.
- **Setup required:** add `DIGEST_CRON_SECRET` as **both** a Cloudflare Pages env var and a secret on the `mashup-approval-digest` Worker (same value in both places), and `DUES_CONTACT_MENTION` as a Cloudflare Pages env var only.

### 12. Backup & Disaster Recovery
This repo (public on GitHub) already covers all code, static data, and scorecard history (`data/scorecards/*.json` is committed by the GitHub Actions fetch job, not KV-only) — that would survive a total loss of the Cloudflare account with zero data loss. The one thing that wouldn't: **Cloudflare KV**, which holds every piece of data the league has actually generated — `players:meta`/`players:discord` (admin-entered profiles), `registrations:*`, `dues:*`, `admin:events` (payouts/teams), stream-submission keys, and per-event handicap snapshots (`<eventId>:handicaps`). None of it has a source to regenerate from if lost.
- **`/admin/backup.html` + `GET /admin/api/backup`** — Access-protected, downloads every KV key/value (minus `ratelimit:*` noise) as one timestamped JSON file. Also tracks `backup:last_export` (KV) so the page can show when it was last run.
- **Deliberately not automated into this repo**: the repo is public, and the export contains player emails and payment records — committing it would leak PII into permanent public git history. It's a manual, on-demand download the admin saves somewhere private (OneDrive, Google Drive, etc.).
- **Also not covered by any backup**: Cloudflare account-level config — env var/secrets (see **Credentials & Keys** below), the two Workers' source + Cron Trigger schedules (`mashup-approval-digest`, `mashup-scorecard-trigger` — not committed anywhere, dashboard-only), the Cloudflare Access/Google SSO policy, and DNS. Losing these breaks the site until manually reconfigured but isn't permanent data loss — reconstructable from this doc.

---

## Hole-in-One Pot

A standing prize pool that grows every season and pays out the first time a member records a hole-in-one in a tour event; until then the full balance carries over.

- **Page:** `hole-in-one.html` (public, linked from the home nav). Shows the current total as an animated count-up, a "how it works" explainer, and a season-by-season contribution table with proportional growth bars.
- **Data is static, hardcoded in the page** — a `CONTRIBUTIONS` array near the bottom of the file. Each season is one row (`{ source, players, perPlayer }`); flat/seed contributions use `{ source, amount, note }` with `perPlayer: null`. The hero total, table amounts, and footer total are all **computed from that array** (`players × perPlayer`, summed) — no hand-maintained arithmetic. As of Season 9 the pot is **$483.60** (admin $100 seed + S6–S9 pools).
- **To update:** add one row to `CONTRIBUTIONS` when a season closes; on payout, flip the status pill to "Claimed" and reset. Deliberately *not* wired to KV/the admin portal given how rarely it changes — revisit if it needs admin-managed editing.

---

## Player-Facing Stats Features (`js/stats.js` engine)

A set of read-only public pages built on a **shared stats engine, `js/stats.js`** — the single source of truth for per-player money/wins/finishes and MashCAP-from-rounds math. `season.html` was refactored to use it too (its `buildStandings` is now a thin wrapper), so money standings agree everywhere.

- **`js/stats.js` exports:** `buildPlayerStats(completedEvents, formats)` (per-player `{earnings, ctpEarnings, wins, podiums, events, finishes[]}` — runs the scoring engine per event, mirrors `season.html`'s old logic incl. team-prize splitting + side pots), `scanScorecardRounds(events)` (reads raw `data/scorecards/*.json` hole-by-hole → per-round gross/net/birdies/eagles; **assumes each player plays their own ball — exclude scramble/alt-shot events if they ever exist**), `mashCapFromRounds`/`rollingMashCap` (MashCAP + its trend over time), `recentForm` (last-N rounds vs the player's *own average* — NOT their MashCAP, which is a best-40% metric that would read everyone "cold").
- **`player.html?name=X`** — player profile: MashCAP hero, an SVG MashCAP-trend chart, Events/Wins/Top-3/Earnings, recent form (hot/cold), event-results timeline, and full round history. Player names across the site (Handicaps + Season standings) link here.
- **`power.html`** — Power Rankings / form guide: ranks the season roster by recent form with a diverging heat bar (Hot = orange, Cold = blue). Season selector via the merged `loadSeasons()`.
- **`records.html`** — Records & Hall of Fame: all-time leaderboards (Money/Results, Scoring, Handicap, CTP) + Hall of Fame (season champions = money-list leader per season, event winners roll, Hole-in-One Club placeholder).
- **Roadmap:** these are phases 1–3 of a 5-phase stats plan (`1+2 → 5 → 4 → 6`). Remaining: Season Superlatives (auto-awards into the recap) and Weekly Pick'em (needs member-submitted picks + player identity — the only one requiring new writes).
- **Local dev:** `serve.mjs` now **proxies `/api/*` to production** (`API_ORIGIN`), so these dynamic pages can be previewed locally with real data instead of 404ing.

---

## Credentials & Keys (Check These Annually)

| What | Where Stored | Expires | Notes |
|------|-------------|---------|-------|
| **GitHub Personal Access Token** | Cloudflare Worker → Settings → Variables & Secrets → `GITHUB_TOKEN` | ~June 2027 | Scope: `workflow` only. Regenerate at GitHub → Settings → Developer Settings → PAT (Classic) |
| **SGT Player API Key** | Cloudflare Pages → Settings → Environment Variables → `player_api_key` | Unknown | Contact SGT admin if it stops working |
| **Discord Streams Webhook** | Cloudflare Pages → Settings → Environment Variables → `DISCORD_STREAMS_WEBHOOK_URL` | Never | Used by `/api/submit-stream` to notify the streams channel when a player submits a YouTube link. |
| **Discord Announce Webhook** | Cloudflare Pages → Settings → Environment Variables → `DISCORD_ANNOUNCE_WEBHOOK_URL` | Never | Used by `/admin/api/announce` to post event announcement posters to the announcements channel. |
| **Discord Register Webhook** *(optional)* | Cloudflare Pages → Settings → Environment Variables → `DISCORD_REGISTER_WEBHOOK_URL` | Never | Used by `/api/register` to ping a channel on each new season registration (no PII — username · region · returning). If unset, registrations still save; the ping is just skipped. |
| **Cloudflare API Token** | GitHub → Repo Settings → Secrets → `CLOUDFLARE_API_TOKEN` | Unknown | Used by GitHub Actions to read/write KV |
| **Cloudflare Account ID** | GitHub → Repo Settings → Secrets → `CLOUDFLARE_ACCOUNT_ID` | Never | Value: `4e0f891a1bcff74ade11ade5d182bac9` |
| **SGT API Key (scorecards)** | GitHub → Repo Settings → Secrets → `SGT_API_KEY` | Unknown | Used by GitHub Actions to fetch scorecards |
| **Access Team Domain** *(optional)* | Cloudflare Pages → Settings → Environment Variables → `CF_ACCESS_TEAM_DOMAIN` | Never | e.g. `https://yourteam.cloudflareaccess.com`. Enables cryptographic verification of admin writes. Found in Zero Trust → Settings → team domain. |
| **Access AUD Tag** *(optional)* | Cloudflare Pages → Settings → Environment Variables → `CF_ACCESS_AUD` | Never | Application Audience tag for the admin Access app. Found in Zero Trust → Access → Applications → (admin app) → Overview. Set together with `CF_ACCESS_TEAM_DOMAIN`. |
| **Digest Cron Secret** | Set to the **same value** in two places: Cloudflare Pages → Environment Variables → `DIGEST_CRON_SECRET`; and the `mashup-approval-digest` Worker → Settings → Variables and Secrets → `DIGEST_CRON_SECRET` | Never (rotate if leaked) | Shared secret protecting `/api/approval-digest` — that endpoint is called by a Cloudflare Worker cron, not a signed-in admin, so it can't sit behind Cloudflare Access like the rest of `/admin/api/*`. A Cloudflare Pages env var change needs a fresh deploy (e.g. an empty commit) to actually take effect on the live Function — this bit twice while first setting this up. |
| **Dues Contact Mention** | Cloudflare Pages → Settings → Environment Variables → `DUES_CONTACT_MENTION` | Never | Text embedded verbatim in the daily approval digest's "DM ___ for payment instructions" line — set to `<@your-numeric-discord-id>` for a real ping, or a plain name if you don't want one. |

---

## How to Renew the GitHub Token (Annual Task)

1. Go to GitHub → profile photo → **Settings → Developer Settings → Personal access tokens → Tokens (classic)**
2. Find `mashup-scorecard-trigger` → click **Regenerate**
3. Copy the new token
4. Go to **Cloudflare dashboard → Workers & Pages → mashup-scorecard-trigger → Settings → Variables and Secrets**
5. Click the edit (pencil) icon next to `GITHUB_TOKEN` → paste the new token → Save

---

## Starting a New Season

1. Add the new season to `data/seasons.json` in the repo (set old season to `"status": "completed"`, new to `"status": "active"`)
2. Add the season's players array
3. Commit and push — site deploys automatically
4. Create events week-by-week via the **Admin → Events** page
5. Scorecards will start auto-fetching within 20 minutes of event creation

---

## Static Data Files (in Repo)

| File | Purpose |
|------|---------|
| `data/seasons.json` | Season definitions and player rosters |
| `data/events.json` | Historical/static events (Seasons 1–9) |
| `data/formats.json` | Built-in game formats (merged with KV `admin:formats` at runtime) |
| `data/scorecards/{id}.json` | Cached scorecard data per tournament |
| `data/ctp/{id}.json` | Cached live closest-to-pin standings per tournament (scraped, see **4. Scorecard Automation**) |
| `data/overrides.json` | Manual leaderboard overrides keyed by event id (see below) |

---

## Manual Leaderboard Overrides (DQ / score corrections)

When a result needs hand-adjustment — a disqualification, a voided stream, a scoring dispute — the fix **must not** be made in `data/scorecards/{id}.json`, because the GitHub Action overwrites those files every 10 minutes. Instead, overrides live in **`data/overrides.json`**, keyed by event id, and are merged onto the event in `loadEvents()` so the scoring engine applies them (and placement money + season standings reshuffle automatically).

```json
{
  "event-40045": {
    "notes": "Salfrado's Round 2 voided — stream verification failed.",
    "dq": [],
    "scoreOverrides": [
      { "player": "salfrado", "round": 2, "hole": 5, "net": 9 }
    ]
  }
}
```

- **`scoreOverrides`** — `[{ player, hole, net, gross?, round? }]`. Corrects specific holes; `round` is optional (omit to apply to every round). `total_net` is recomputed. Applied in `scoring.js` → `applyManualOverrides()` at the top of `applyFormat`.
- **`dq`** — `["player"]`. Removes the player from the field entirely (no result, no money).
- **`notes`** — public banner shown on the event leaderboard explaining the adjustment.
- Corrected holes are flagged on the expanded scorecard with an orange ✱ and a "manually adjusted score" legend.
- This is a repo file, so edits survive the refresh and deploy on push. It works for both Season 9 and admin events, though placement **money only reshuffles for admin events** (positional payouts); Season 9 payouts are hard-coded to winner names.

Admin-created events/formats for Season 10+ live in **Cloudflare KV**, not these files.

## Adding a New Game Format

New formats must be defined in Claude Code — **do not use the admin UI's "New Format" panel** for genuinely new scoring logic. The admin panel only creates named variations of an existing `type`. New scoring logic requires:
1. New function in `js/scoring.js`
2. New `case` in the `applyFormat()` switch statement
3. New entry in `data/formats.json` (with `tiebreakers[]` array and an `allowance` — see **Handicap Allowance (per format)** below; omit it only for a format like `invitational` that has no per-hole scoring engine)
4. New `<option>` in the admin events.html `nf-type` dropdown (the **`f-format`** event dropdown is dynamic via `loadFormats()` and auto-includes it; only `nf-type` is hardcoded)

Most recent example: **`best-ball-3man`** ("3-Man, 2 Best Ball", `calcBestBall3Man`) — every hole sums the two lowest NET scores of the three teammates; tie → total team aggregate. Built by copying `calcBest2Worst2All3` (the same per-hole "best 2 of 3" logic), so the result shape plugs straight into payouts/CTP/side-pots.

**Manual / one-off scoring:** the `invitational` type has **no engine logic** — `event.html` detects it and renders final standings straight from the event's hand-entered `payouts`/`ctp` (the event has `tournamentId: null`, no scorecards). Use this pattern for tournaments scored outside the system (e.g. the multi-week elimination Invitational).

### Round Completion (`isCardComplete()`)

Every format function gates on a round "counting" — originally just `card.status === 'Completed'`. Confirmed 2026-09 (S10W1) that SGT can leave a fully-played round's `status` as **`"Pending"`** even once every hole is scored and the round shows as done on SGT's own site — likely because `status` tracks the player's overall multi-round tournament entry, not this specific round card.

`isCardComplete(card)` in `js/scoring.js` handles this: `true` for `status === 'Completed'` as before, or `status === 'Pending'` **and** every `hole{1-18}_net` is present (the real signal play finished). A round still genuinely in progress (some holes null) still correctly waits regardless of status. All 14 `status === 'Completed'` / `status !== 'Completed'` checks across every format function go through this one helper — if a similar gap ever shows up for some other status string, fix it here once, not per-format.

## SGT Loading File (Team Registration CSV)

Before each event, the admin generates a CSV for SimulatorGolfTour via `/admin/teams.html` Step 2:
- **Format:** 10 columns — `Player1, HCP1, Player2, HCP2, Player3, HCP3, Player4, HCP4, teamID, opponentID`
- **Team events:** one row per team, sequential teamID starting at 10001
- **Solo events** (teamSize < 2): one row per player, only first 2 columns filled, no teamID
- **Handicap used:** `regCap` (MashCAP, falling back to SGT `rawCap` until a player has a MashCAP) run through the event's format **handicap allowance**, then offset so the field's best resulting handicap plays to scratch — see **Handicap Allowance (per format)** below for the exact order of operations. Must be refreshed within 24 hours before generating.
- **Encoding:** UTF-8 BOM (`﻿`) required for SGT compatibility. **Line endings: `\r\n` (CRLF), not `\n`** — matches RFC 4180 and what Excel/Sheets writes; the generator used LF-only until 2026-09, which a strict `\r\n`-splitting parser would read as one unbroken line instead of N rows (looks like a total import failure, not a few bad rows). File also ends with a trailing `\r\n`.

## Handicap Allowance (per format)

Each format in `data/formats.json` carries an `allowance` (e.g. `0.80` = 80%) — how much of a player's full handicap actually applies for that format, per standard USGA guidance (individual stroke play closer to full, team best-ball formats reduced since fewer than all players' scores count toward the team total each hole). `invitational` has none — it has no per-hole scoring engine to apply it to.

- **Current table:** Solo Ringer 85% · 2-Man Shamble 70% · every other scored format (Nassau, Escalator of Doom, Devil's Draw 3/4-man, Stableford, Best 2/Worst 2/All 3, Lone Ranger, Best-Ball 3-Man, Modified BB) 80%.
- **Where it's applied:** `admin/teams.html` (source of truth — `generateSgtCsv()`, the actual file SGT gets, plus `renderTeamResults()`'s draw preview), `admin/poster-preview.html` (`buildPoster()`/`buildDiscordMessage()`), and `event-teams.html` (public team/player view). Each has its own copy of the same `regCap`/`buildAllowedCapFn`-shaped logic (not a shared module) — **order matters and must match across all three**: each player's raw cap is multiplied by the allowance *first* (`regCap × allowance`), and only then is the field offset so the lowest resulting handicap plays to scratch. Doing the offset before the allowance would dilute the allowance instead of applying it to the number SGT actually computes net scores from. If the formula ever changes, update all three call sites.
- **Deliberately not applied anywhere else** — `regCap` stays unmodified for the tiered-draw balancing logic and Lone Ranger slot ordering (both about raw skill, not what gets registered with SGT), and `js/scoring.js` never touches handicaps at all; it just consumes whatever `net` SGT already computed off the allowance-adjusted number sent in the loading file.
- **Public copy:** rules.html and requirements.html's Handicapping section states the allowance range in prose (not a full per-format table) — update both if the table above changes.
- **Published on the event page:** `event.html`'s header shows a `🎯 XX% ALLOWANCE` chip next to the format chip, for every event whose format has an `allowance` (omitted for `invitational`).
- **On the announcement poster:** `admin/poster-preview.html` shows `🎯 XX% Handicap Allowance` in the poster's top meta row and in the Discord announcement text, and — per player — the raw MashCAP alongside the allowance-adjusted number they actually play off that event (`raw → effective`). This page independently re-derives the same allowance-adjusted numbers as the SGT Loading File (same `regCap`/`buildAllowedCapFn` logic, duplicated rather than shared since the two pages are otherwise unrelated) — it also now scopes its player field to the event's season roster (`getSeasonRoster()`, fetching `/api/seasons` + `data/seasons.json` same as `admin/teams.html`) instead of the all-time master roster it used before, so the poster's numbers actually match what got sent to SGT.
- **Creating a custom format:** the admin events.html "New Format" panel has a **Handicap Allowance %** field (defaults to 100) that becomes the new format's `allowance`.

---

## Frontend Conventions

These patterns are applied across all admin + public pages — match them when adding pages or tables.

- **Money formatting:** all standings/prize money is shown to **two decimal places** (`toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`). Each page defines its own `money`/`fmt` helper — use 2/2, not `minimumFractionDigits: 0` (which drops `$258.50` → `$258.5`).

- **Custom brand colors in JS-rendered content:** the Tailwind Play CDN only generates config colors (e.g. `text-flame` = `#f97316`) for HTML present at load time — **not** for rows/cells injected later via JavaScript, which render white. Every page therefore defines the brand colors as **real CSS rules** in its `<style>` block: `.text-flame { color:#f97316 }` (and `.hover\:text-flame:hover { color:#f97316 }`). Use the `text-flame` class freely; the CSS rule guarantees the color in dynamic tables.
- **Sticky table headers:** all data tables keep their column headers pinned while scrolling. Pattern: wrap the table in `<div class="overflow-auto" style="max-height: calc(100vh - 12rem)">` and add `thead th { position: sticky; top: 0; z-index: 20; background: <header-bg>; box-shadow: inset 0 -1px 0 #2c2c2c; }` to the page's `<style>`. The `overflow` wrapper is **required** — any non-`visible` overflow ancestor otherwise scopes the sticky to itself and breaks it. The `max-height` offset is per-page (more content above the table → larger offset). `event.html` leaderboards use their own tuned offset (`top: 56px`) to clear a sticky bar.

---

## If Something Breaks

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Scorecards not updating | GitHub token expired | Renew token (see above) |
| Scorecards not updating | Cloudflare Worker stopped | Check Worker → Observability → Logs for errors |
| Admin page won't load / redirects to login | Cloudflare Access policy issue | Check Zero Trust dashboard → Access → Applications |
| Admin writes fail with `403 "admin access required"` | Access path no longer covers `/admin/api/` | Zero Trust → Access → Applications → admin app → Destinations → set Path to `admin` |
| Admin writes fail with `403 "invalid access token"` | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is wrong | Re-copy values (see API Security section) or delete both env vars to fall back to layers 1–2, then redeploy |
| Players handicap refresh fails | SGT API key expired | Contact SGT admin for new key, update `player_api_key` in Cloudflare Pages env vars |
| Site not updating after a push | Cloudflare Pages build failed | Check Cloudflare Pages → Deployments tab for error |
| `mashupgolf.com` shows **Error 522** | Domain has DNS records but isn't bound as a Pages **Custom domain** (no routing) | Pages project → Custom domains → add `mashupgolf.com` (and `www`); let Pages create the records |
| `mashupgolf.com` blocked / 403 on the work network | Zscaler "Newly Registered Domains" category (corporate networks) | Use `pages.dev`, test off-network, or wait ~30 days / request an InfoSec allowlist |
| MashCAP column shows amber ⚠ fallback for everyone | No MashCAP stored yet — `player-hcp-rounds` 24h cap, or no refresh since the feature shipped | Run **Refresh Handicaps**; the full roster populates once the SGT 24h window has reset |
