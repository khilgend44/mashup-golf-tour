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
- New game formats are built through code (`data/formats.json` + `js/scoring.js`), never hand-added through an admin UI.
- `git pull --rebase origin main` before every push — frequent automated "chore: refresh…" commits land often but never touch the files we edit, so rebases are always clean.
