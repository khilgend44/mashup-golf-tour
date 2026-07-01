# MashUp Golf Tour — Architecture Reference

Last updated: June 26, 2026

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
- **Pages URL:** https://mashup-golf-tour.pages.dev (always works; use this when the custom domain misbehaves)
- **Repo:** https://github.com/khilgend44/mashup-golf-tour
- Every `git push` to `main` auto-deploys the site within ~1–2 minutes. No manual deploy step.
- **Heads-up (Zscaler):** on corporate network, `mashupgolf.com` is blocked by Zscaler's *"Newly Registered and Observed Domains"* category (the page is fine — Zscaler intercepts before it reaches Cloudflare). Use `pages.dev` on the corporate network, or test from a non-corporate network; the block clears as the domain ages (~30 days) or via an InfoSec allowlist request.
- If a deploy ever seems stuck (rare Cloudflare-side hiccup), an empty commit (`git commit --allow-empty`) re-triggers it.

### 2. Admin Portal — `/admin`
- **URL:** https://mashup-golf-tour.pages.dev/admin
- Protected by **Cloudflare Access** (Google SSO — only approved Google accounts can log in)
- Pages:
  - `/admin/guide.html` — wiki-style operator's guide (TOC sidebar + scroll-spy): what each portal page does, the weekly workflow, the SGT admin "Game" functions (Reset Player, Delete Save Game, Update Player Resume, Create/Modify Scorecard), and Access/deploy notes. Linked as a card on the portal index. Static content — update it when admin workflows change.
  - `/admin/players.html` — manage player roster, view/refresh handicaps
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

### 2b. API Endpoints & Security Model
The API is split into **public reads** and **protected writes** so the public site can load data freely while only an authenticated admin can change it.

- **Public reads — `functions/api/*`** (route `/api/*`, no auth):
  - `/api/events-admin?type=events|formats|scrape` — event/format lists + SGT page scrape (GET)
  - `/api/seasons` — season list (GET)
  - `/api/players` — roster + handicaps (GET)
  - `/api/player-rounds` — stored per-round MashCAP data; whole map or `?player=x` (GET)
  - `/api/event-public`, `/api/get-streams` — public event/team + stream data (GET)
  - `/api/submit-stream` — **public write by design** (players submit their own YouTube links)
- **Protected writes — `functions/admin/api/*`** (route `/admin/api/*`, behind Cloudflare Access):
  - `/admin/api/events` — create/update/delete/activate/complete event, create/delete format, **`set-devils-draw`** (saves a Devil's Draw `devilsDraw`+`revealOrder` onto a KV event — called by the "Save Draw to Event" button in `event.html?...&reveal=true`)
  - `/admin/api/players` — onboard/add/remove player, refresh handicaps
  - `/admin/api/seasons` — create/update/archive season
  - `/admin/api/announce` — post event poster to Discord
- Admin pages keep reads on `/api/*` constants (`API`, `PLAYERS_API`) and send writes to `/admin/api/*` constants (`API_WRITE`, `PLAYERS_WRITE`).

**Three layers of protection on every write** (`functions/admin/api/_lib.js` → `requireAccess()`):
1. **Cloudflare Access gate** — `/admin/api/*` sits under `/admin/`, so the same Access application that guards the admin pages blocks unauthenticated requests *before* they reach the function code.
2. **Required auth header** — the function rejects any request lacking the `Cf-Access-Jwt-Assertion` header (Cloudflare only injects this after a request passes the gate).
3. **Cryptographic token verification** — when `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` env vars are present, the function verifies the token's RS256 signature (against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), audience, and expiry. If the env vars are absent it falls back to header-presence only (layer 2).

**Current status:** all three layers are active in production — `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set in Cloudflare Pages env vars. If those vars are ever lost/cleared, writes still hold at layers 1–2.

**Cloudflare Access config (confirmed working):**
- Zero Trust → Access → Applications → admin app → **Destinations**: must include **every hostname** the site is served on — both `mashup-golf-tour.pages.dev` **and** the custom domain `mashupgolf.com` (+ `www.` if it resolves), each with Path `admin`. ⚠️ **Access matches on hostname+path** — a hostname NOT listed here is NOT gated, so `/admin` on that hostname loads without the Google login. (The `/admin/api/*` endpoints still hold via the in-code `requireAccess` header check, but the pages themselves would be viewable.)
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

### Team Assignment in the Scoring Engine
- All team formats (`js/scoring.js` → `resolveTeamKey`) group players into teams using **`event.teams` (the admin-defined draw, stored in KV) as the authoritative source** whenever it is present.
- **Why KV-first (changed June 2026):** SGT's per-card `TeamPlayer1–4` fields are sometimes returned *incomplete* (one or more slots blank), which fragments a single team into partial teams + solo players. This surfaced on the first 4-man Devil's Draw (S8W6), where the leaderboard showed a mix of 4-man, 3-man, and solo "teams." Preferring the admin draw eliminates it.
- **Fallback to SGT `TeamPlayer1–4`** only when the event has no `event.teams`, or for a player who isn't on any roster team (e.g. a sub) — in which case they're attached to a team via a listed teammate, or grouped by their own SGT fields.
- The Devil's Draw **pre-draw** view (`event.html`) and the **scoring engine** both use this KV-first logic so they agree.
- `event.teams` is an array of arrays of player names: `[['A','B','C'], ['D','E','F'], ...]` — saved by the admin teams page.
- Applies to all team formats: Escalator, Devil's Draw (3-man & 4-man), Stableford, Best2/Worst2, Shamble, Lone Ranger.

### 5. Cron Trigger — Cloudflare Worker
- **Worker name:** `mashup-scorecard-trigger`
- **Cloudflare dashboard:** Workers & Pages → mashup-scorecard-trigger
- Fires every **20 minutes** and calls the GitHub API to trigger the scorecard workflow
- Why not GitHub's built-in scheduler? GitHub's scheduler is unreliable for frequent intervals on public repos — it skips runs. Cloudflare's cron is precise.

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
  - Only covers admin-created events (KV-stored, Season 10+); historical events return 404

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
- **MashCAP drives team registration and scoring.** Both the Players and Teams pages use a `regCap(h)` accessor = MashCAP if present, else SGT `rawCap` (fallback only until a player has a MashCAP). The adjusted/relative handicap written to the SGT Loading File (`round(regCap − minRegCap)`) and the balanced-team tiers are all based on this.
- Computed in `computeMashCap()` in `functions/admin/api/players.js`. A temporary **protected** debug inspector lives at `functions/admin/api/inspect-rounds.js` — it can return the computed table for the roster, and has demo-seed params (`?seedMashCap=player&value=…`, `?seedRounds=player`) that write directly to KV for previewing the pages before a real refresh. **Remove it once the feature is settled.**
- A real refresh overwrites any seeded/demo values with live data, so demo seeds are self-cleaning.
- **Public pages:** `handicaps.html` (season-scoped MashCAP table, linked from the home nav with a "Why MashCAP vs COMBO" explainer; shows a last-updated timestamp from `players:last_refresh`) and `counting-events.html?player=X` (per-player breakdown of every round, sorted newest-first, with the best 40% marked). The latter reads `players:rounds` via the public `/api/player-rounds` endpoint. The refresh action persists those rounds to KV.

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
3. New entry in `data/formats.json` (with `tiebreakers[]` array)
4. New `<option>` in the admin events.html `nf-type` dropdown (the **`f-format`** event dropdown is dynamic via `loadFormats()` and auto-includes it; only `nf-type` is hardcoded)

Most recent example: **`best-ball-3man`** ("3-Man, 2 Best Ball", `calcBestBall3Man`) — every hole sums the two lowest NET scores of the three teammates; tie → total team aggregate. Built by copying `calcBest2Worst2All3` (the same per-hole "best 2 of 3" logic), so the result shape plugs straight into payouts/CTP/side-pots.

**Manual / one-off scoring:** the `invitational` type has **no engine logic** — `event.html` detects it and renders final standings straight from the event's hand-entered `payouts`/`ctp` (the event has `tournamentId: null`, no scorecards). Use this pattern for tournaments scored outside the system (e.g. the multi-week elimination Invitational).

## SGT Loading File (Team Registration CSV)

Before each event, the admin generates a CSV for SimulatorGolfTour via `/admin/teams.html` Step 2:
- **Format:** 10 columns — `Player1, HCP1, Player2, HCP2, Player3, HCP3, Player4, HCP4, teamID, opponentID`
- **Team events:** one row per team, sequential teamID starting at 10001
- **Solo events** (teamSize < 2): one row per player, only first 2 columns filled, no teamID
- **Handicap used:** adjusted MashCAP (`Math.round(regCap - minRegCap)`, where `regCap` = MashCAP, falling back to SGT `rawCap` until a player has a MashCAP) — must be refreshed within 24 hours before generating
- **Encoding:** UTF-8 BOM (`﻿`) required for SGT compatibility

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
