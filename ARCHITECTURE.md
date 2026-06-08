# MashUp Golf Tour — Architecture Reference

Last updated: June 2026

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
- Two pages:
  - `/admin/players.html` — manage player roster, view/refresh handicaps
  - `/admin/events.html` — create/manage seasons and events

### 3. Data Storage — Cloudflare KV
- **Namespace ID:** `a6cbb9bc3e784be88136dbffe9f9796f`
- Stores admin-created data that shouldn't be hardcoded in the repo:
  - `admin:events` — events created via admin portal
  - `admin:formats` — custom game formats
  - `players:roster` — player list
  - `players:handicaps` — handicap data from SGT API
  - `players:last_refresh` — timestamp of last handicap pull
- Static/historical data lives in `data/` JSON files in the repo instead.

### 4. Scorecard Automation — GitHub Actions
- **Workflow file:** `.github/workflows/fetch-scorecards.yml`
- Fetches live scorecards from SGT API for all non-completed events in the active season
- Commits scorecard JSON files to `data/scorecards/{tournamentId}.json`
- Merges both static `data/events.json` and KV-stored events so admin-created events are included
- **Triggered by:** Cloudflare Worker (not GitHub's built-in scheduler — see below)

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
- Also posts a notification to a **Discord webhook** when a stream is submitted
- Discord webhook URL stored in Cloudflare Pages environment variables as `DISCORD_WEBHOOK_URL`

### 7. SGT Handicap API
- Pulls player handicap data from SimulatorGolfTour
- Rate-limited to **once per 24 hours**
- Triggered manually from the admin Players page ("Refresh Handicaps" button)

---

## Credentials & Keys (Check These Annually)

| What | Where Stored | Expires | Notes |
|------|-------------|---------|-------|
| **GitHub Personal Access Token** | Cloudflare Worker → Settings → Variables & Secrets → `GITHUB_TOKEN` | ~June 2027 | Scope: `workflow` only. Regenerate at GitHub → Settings → Developer Settings → PAT (Classic) |
| **SGT Player API Key** | Cloudflare Pages → Settings → Environment Variables → `player_api_key` | Unknown | Contact SGT admin if it stops working |
| **Cloudflare API Token** | GitHub → Repo Settings → Secrets → `CLOUDFLARE_API_TOKEN` | Unknown | Used by GitHub Actions to read/write KV |
| **Cloudflare Account ID** | GitHub → Repo Settings → Secrets → `CLOUDFLARE_ACCOUNT_ID` | Never | Value: `4e0f891a1bcff74ade11ade5d182bac9` |
| **SGT API Key (scorecards)** | GitHub → Repo Settings → Secrets → `SGT_API_KEY` | Unknown | Used by GitHub Actions to fetch scorecards |

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
| `data/formats.json` | Built-in game formats |
| `data/scorecards/{id}.json` | Cached scorecard data per tournament |

Admin-created events/formats for Season 10+ live in **Cloudflare KV**, not these files.

---

## If Something Breaks

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Scorecards not updating | GitHub token expired | Renew token (see above) |
| Scorecards not updating | Cloudflare Worker stopped | Check Worker → Observability → Logs for errors |
| Admin page won't load / redirects to login | Cloudflare Access policy issue | Check Zero Trust dashboard → Access → Applications |
| Players handicap refresh fails | SGT API key expired | Contact SGT admin for new key, update `player_api_key` in Cloudflare Pages env vars |
| Site not updating after a push | Cloudflare Pages build failed | Check Cloudflare Pages → Deployments tab for error |
