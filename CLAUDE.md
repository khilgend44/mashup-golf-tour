# CLAUDE.md — MashUp Golf Tour

Static site + Cloudflare Pages Functions + KV (`khilgend44/mashup-golf-tour`). Admin portal lives under `/admin`, gated by Cloudflare Access.

**Read `ARCHITECTURE.md` before any architectural change** — it's the living source of truth for every component, API, and KV key. Update it at the end of any session that adds a new page, endpoint, or KV key.

## Local dev
- `node serve.mjs` serves the project at `http://localhost:3000`. Don't start a second instance if one's already running.
- There's no local Cloudflare Functions runtime: every `/admin/api/*` and `/api/*` call 404s against `serve.mjs`. That's expected, not a bug — smoke-test pages with headless Chrome instead of expecting API calls to succeed locally:
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --disable-gpu --dump-dom --virtual-time-budget=4000 http://localhost:3000/path.html`, then check stderr for `SyntaxError`/`ReferenceError`/`TypeError`.

## KV conventions
- Data written often (dues, payouts, registrations, player-meta) uses **one KV key per record** (`<type>:<season>:<username>`), never a shared per-season blob — a shared-blob design previously lost data to a read-modify-write race in production.
- A shared blob (`admin:events`, `admin:schedule`, `admin:money-tracker`) is fine only for low-write-frequency admin data.

## Project rules
- **Cache-busting — bump the `?v=` label whenever you change a file in `js/` or `css/`.** On the real domain (`mashupgolf.com`) Cloudflare serves `.js`/`.css` with `max-age=14400` (4h) — `_headers`' `no-cache` is only honoured on `mashup-golf-tour.pages.dev`; something in the zone overrides it. So a changed file at an *unchanged* URL stays stale in any browser that loaded it in the last 4h. HTML is always fresh (`must-revalidate`), which is why bumping the label in the HTML works. Current label: `20261112a` — used on every `api.js` import (pages, `admin/*`, and `js/stats.js`), `css/theme.css` and `js/nav.js` links; `scoring.js`/`stats.js` have their own (`20261026a`/`20261103a`) — change a label when *that* file changes. **Adding an export to `api.js` and importing it from a page without bumping the label is exactly what broke the whole site on 2026-11-11** (home spinner, Handicaps error, until a hard refresh). Find them with `grep -rn "api.js?v=" --include='*.html' --include='*.js' .`
- New game formats are built through code (`data/formats.json` + `js/scoring.js`), never hand-added through an admin UI.
- `git pull --rebase origin main` before every push — frequent automated "chore: refresh…" commits land often but never touch the files we edit, so rebases are always clean.
