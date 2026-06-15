# MashUp Golf Tour — Architecture Reference

Last updated: June 12, 2026

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
- **URL:** https://mashup-golf-tour.pages.dev
- **Repo:** https://github.com/khilgend44/mashup-golf-tour
- Every `git push` to `main` auto-deploys the site within ~1 minute.
- No manual deploy step needed.

### 2. Admin Portal — `/admin`
- **URL:** https://mashup-golf-tour.pages.dev/admin
- Protected by **Cloudflare Access** (Google SSO — only approved Google accounts can log in)
- Pages:
  - `/admin/players.html` — manage player roster, view/refresh handicaps
  - `/admin/events.html` — create/manage seasons and events
    - SGT Event URL must be entered first — it unlocks the rest of the form and auto-populates event name, dates, rounds, and week number
    - Event name is locked after SGT scrape and does not change when format is changed
    - **Details** button shows a metadata panel (format, payouts, rounds, etc.) for active/completed events
    - **↺ Sync** button re-scrapes SGT to refresh dates and round settings on an existing event
  - `/admin/teams.html` — draw teams for an event (Steps 1–4):
    - Step 1: Create Teams — three modes:
      - **Tiered Draw**: 1 player pulled from each handicap tier, produces balanced teams
      - **Completely Random**: all players shuffled, pure luck
      - **Manual Entry**: click-to-assign UI — select a player chip, click a team slot to place them; Save button enabled when all slots filled
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
  - `/api/event-public`, `/api/get-streams` — public event/team + stream data (GET)
  - `/api/submit-stream` — **public write by design** (players submit their own YouTube links)
- **Protected writes — `functions/admin/api/*`** (route `/admin/api/*`, behind Cloudflare Access):
  - `/admin/api/events` — create/update/delete/activate event, create/delete format
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
- Zero Trust → Access → Applications → admin app → **Destinations**: Domain `mashup-golf-tour.pages.dev`, Path `admin`.
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
  - `players:handicaps` — handicap data from SGT API (object keyed by lowercase player name → `{ rawCap, comboCap, numEvents, ... }`)
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
- All team formats (`js/scoring.js`) determine teams using **`TeamPlayer1/2/3/4` from the SGT API scorecard** as the primary source
- **Fallback:** if those fields are absent (e.g. tournament was not uploaded as a team event in SGT), teams are resolved from `event.teams` stored in KV
- `event.teams` is an array of arrays of player names: `[['A','B','C'], ['D','E','F'], ...]` — saved by the admin teams page
- This fallback applies to all 7 team formats: Escalator, Devil's Draw (3-man & 4-man), Stableford, Best2/Worst2, Shamble, Lone Ranger

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

---

## Credentials & Keys (Check These Annually)

| What | Where Stored | Expires | Notes |
|------|-------------|---------|-------|
| **GitHub Personal Access Token** | Cloudflare Worker → Settings → Variables & Secrets → `GITHUB_TOKEN` | ~June 2027 | Scope: `workflow` only. Regenerate at GitHub → Settings → Developer Settings → PAT (Classic) |
| **SGT Player API Key** | Cloudflare Pages → Settings → Environment Variables → `player_api_key` | Unknown | Contact SGT admin if it stops working |
| **Discord Streams Webhook** | Cloudflare Pages → Settings → Environment Variables → `DISCORD_STREAMS_WEBHOOK_URL` | Never | Used by `/api/submit-stream` to notify the streams channel when a player submits a YouTube link. |
| **Discord Announce Webhook** | Cloudflare Pages → Settings → Environment Variables → `DISCORD_ANNOUNCE_WEBHOOK_URL` | Never | Used by `/admin/api/announce` to post event announcement posters to the announcements channel. |
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
- This is a repo file, so edits survive the refresh and deploy on push. It works for both Season 9 and admin events, though placement **money only reshuffles for admin events** (positional payouts); Season 9 payouts are hard-coded to winner names.

Admin-created events/formats for Season 10+ live in **Cloudflare KV**, not these files.

## Adding a New Game Format

New formats must be defined in Claude Code — **do not use the admin UI's "New Format" panel** for genuinely new scoring logic. The admin panel only creates named variations of an existing `type`. New scoring logic requires:
1. New function in `js/scoring.js`
2. New `case` in the `applyFormat()` switch statement
3. New entry in `data/formats.json` (with `tiebreakers[]` array)
4. New `<option>` in the admin events.html `nf-type` dropdown

## SGT Loading File (Team Registration CSV)

Before each event, the admin generates a CSV for SimulatorGolfTour via `/admin/teams.html` Step 2:
- **Format:** 10 columns — `Player1, HCP1, Player2, HCP2, Player3, HCP3, Player4, HCP4, teamID, opponentID`
- **Team events:** one row per team, sequential teamID starting at 10001
- **Solo events** (teamSize < 2): one row per player, only first 2 columns filled, no teamID
- **Handicap used:** adjusted handicap (`Math.round(rawCap - minRaw)`) — must be refreshed within 24 hours before generating
- **Encoding:** UTF-8 BOM (`﻿`) required for SGT compatibility

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
