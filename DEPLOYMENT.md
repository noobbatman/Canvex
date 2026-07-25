# Canvex — Deployment Guide (Phase 13)

This guide takes Canvex from the local stack to a public deployment:
**backend + workers + Postgres + Redis on Render** and **frontend on Vercel**,
with **CI/CD via GitHub Actions**.

The repository already contains everything the platforms need:

| File | Purpose |
|------|---------|
| [`render.yaml`](render.yaml) | Render Blueprint — web service, AI worker, webhook worker, Postgres, Redis |
| [`backend/Procfile`](backend/Procfile) | Process definitions for Railway (alternative to Render) |
| [`backend/Dockerfile`](backend/Dockerfile) | Container build; honours `$PORT` |
| [`frontend/vercel.json`](frontend/vercel.json) | Vite build + SPA rewrites (so `/view/:token` resolves) |
| [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) | Tests on every push/PR; deploy on push to `main` |

The app is written to be deploy-portable:

- **Database URL normalisation** — the backend rewrites `postgres://` /
  `postgresql://` (what Render/Railway hand out) to `postgresql+asyncpg://`
  and strips `sslmode`, so their connection strings work unchanged
  ([`backend/app/config.py`](backend/app/config.py)).
- **`$PORT`** — the start command binds to the platform-injected port.
- **`wss://`** — the frontend derives the WebSocket URL from `VITE_API_URL`
  (http→ws, https→wss) automatically.
- **Migrations on boot** — in production the app runs `alembic upgrade head`
  during startup (plan 13.7), so each deploy ships schema changes.
- **Fail-fast config** — the app refuses to start in production with the
  default JWT secret or a wildcard CORS origin.

---

## Prerequisites

- The repo pushed to GitHub (already done: `mayesha715/Canvex`).
- Accounts on [Render](https://render.com) and [Vercel](https://vercel.com)
  (both have free tiers; Render's managed Postgres supports `pgvector` on all
  plans, including free — note the free DB is deleted after ~30 days).
- A [Google Gemini API key](https://aistudio.google.com/apikey) (optional — the
  AI pipeline uses a deterministic local fallback when it's blank).

---

## 13.1–13.3  Backend, Postgres & Redis on Render (Blueprint)

The `render.yaml` Blueprint provisions all four backend pieces at once.

1. In Render: **New → Blueprint**, connect the `Canvex` repo, and apply.
   It creates: `canvex-postgres`, `canvex-redis`, `canvex-api` (web),
   `canvex-ai-worker`, `canvex-webhook-worker`.
2. Render auto-wires `DATABASE_URL`, `REDIS_URL`, and a generated
   `JWT_SECRET_KEY`. You must set the `sync: false` secrets in the dashboard:
   - `GEMINI_API_KEY` — your key (or leave blank for the local fallback).
   - `CORS_ALLOW_ORIGINS` — your Vercel URL, e.g. `https://canvex.vercel.app`
     (comma-separate multiple; **never** `*`).
   - `API_BASE_URL` — the web service's public URL, e.g.
     `https://canvex-api.onrender.com` (set it after the first deploy, when
     Render has assigned the URL, then redeploy). This is used for upload and
     invite links.
3. First boot runs migrations automatically (`RUN_MIGRATIONS_ON_STARTUP=true`
   on the web service). The workers have it set to `false` so only one process
   migrates. Watch the web service logs for `database migrations up to date`.

> **pgvector:** the migration enables the `vector` extension automatically. If
> it ever fails with `extension "vector" is not available`, run
> `CREATE EXTENSION vector;` once from the Render Postgres shell, then redeploy.
> **Plan note:** Render retired the old `standard`/`starter` plan names — valid
> ones are `free`, `basic_256mb`, `basic_1gb`, … The Blueprint uses `free`; the
> free DB is deleted ~30 days after creation, so bump the plan if you need it
> to persist beyond that.

### Supabase for Postgres (persistent free tier)

Render's free Postgres is deleted ~30 days after creation. Supabase gives a
**persistent free Postgres with pgvector** — keep the backend, workers, and Redis
on Render and point only the database at Supabase.

1. Create a project at [supabase.com](https://supabase.com) (region near your
   Render region). Choose a DB password without URL-special characters (or
   percent-encode it in the connection string).
2. **Enable pgvector:** dashboard → **Database → Extensions** → search `vector`
   → enable. (The migrations also `CREATE EXTENSION IF NOT EXISTS` for
   `pgcrypto` / `uuid-ossp` / `vector`, which the `postgres` role may run.)
3. Copy the **Session pooler** connection string: dashboard → **Connect** →
   *Session pooler*, port **5432**. It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   - Use the **session** pooler (5432) — it's IPv4 (works from Render) and keeps
     the prepared statements asyncpg relies on. Avoid the **transaction** pooler
     (6543), which breaks asyncpg prepared statements, and the direct
     `db.<ref>.supabase.co` host, which is IPv6-only.
4. On the Render **web service and both workers** → Environment set:
   - `DATABASE_URL` = the session-pooler string
   - `DATABASE_SSL` = `require` (Supabase requires TLS; the app supplies SSL the
     asyncpg way and still auto-rewrites `postgresql://` → `postgresql+asyncpg://`)
5. Redeploy the web service; boot-time migrations run against Supabase — watch for
   `database migrations up to date`. Then you can delete the Render Postgres.

> **Connections:** Supabase's free tier caps connections. The three services each
> open pooled connections under load; the session pooler multiplexes, but if you
> hit limits, lower `pool_size`/`max_overflow` in `backend/app/db/session.py`.
> **Uploads still live on the API disk** — Supabase Storage (an object store) is a
> good place to move them later (also fixes the upload-persistence audit item).

### Railway alternative

Railway detects Python via Nixpacks and uses [`backend/Procfile`](backend/Procfile).
Create one service per process (`web`, `ai_worker`, `webhook_worker`) from the
same repo with root directory `backend/`, add Postgres and Redis plugins, and
set the same environment variables. Use the **internal** connection URLs.

---

## 13.4  Frontend on Vercel

1. In Vercel: **Add New → Project**, import the `Canvex` repo.
2. Set **Root Directory** to `frontend/`. Vercel auto-detects Vite and reads
   [`frontend/vercel.json`](frontend/vercel.json) for the build + SPA rewrites.
3. Add one environment variable: `VITE_API_URL` = your Render backend URL
   (e.g. `https://canvex-api.onrender.com`). The WebSocket URL (`wss://…`) is
   derived from it automatically.
4. Deploy. Vercel redeploys on every push to `main`.

After the frontend URL exists, go back and set the backend's
`CORS_ALLOW_ORIGINS` (and `API_BASE_URL`) to match, then redeploy the backend.

---

## 13.5  CORS

`CORS_ALLOW_ORIGINS` is a comma-separated allowlist read from the environment.
Locally it defaults to the Vite dev/preview ports. In production set it to
exactly your Vercel domain(s). The startup guard **aborts** if it contains `*`
while `ENVIRONMENT=production`.

---

## 13.5b  Social & institutional sign-in

Both live under the "or" divider on the login screen. The frontend reads
`GET /auth/config` on load to decide what to show, so **all configuration is on
the backend** — nothing to set in Vercel.

**Institutional Login** works out of the box (no setup): it registers/authenticates
with the existing password system but requires an institutional email. Any `.edu`
or `.ac` domain is always accepted (`.edu`, `.edu.bd`, `.ac`, `.ac.uk`, `.ac.bd`,
…). `INSTITUTIONAL_EMAIL_DOMAINS` (comma-separated) only *adds* further domains
for an institution on a non-academic domain — it never restricts `.edu` / `.ac`.
The domain is checked when **creating** an account; existing accounts can always
sign in.

**Sign in with Google** stays hidden until you set `GOOGLE_CLIENT_ID`:

1. [Google Cloud Console](https://console.cloud.google.com) → create/select a
   project → **APIs & Services → Credentials → Create credentials → OAuth client
   ID → Web application**.
2. Under **Authorized JavaScript origins** add your frontend origins, exactly
   (scheme + host, no path/trailing slash):
   - `http://localhost:5173` (local dev)
   - `https://your-app.vercel.app` (production)
   No redirect URIs are needed — Google Identity Services uses the origins.
3. Copy the **Client ID** (looks like `…-….apps.googleusercontent.com`) and set
   it as `GOOGLE_CLIENT_ID` on the Render **web service** (Environment tab). The
   client ID is public and is served to the browser via `/auth/config`, so it
   only lives on the backend. Save → wait for redeploy.

The backend verifies each Google ID token against `GOOGLE_CLIENT_ID`, then finds
or creates the user (linking by verified email). OAuth-only accounts have no
password (`users.password_hash` is now nullable — see migration
`202607220001`).

---

## 13.6  CI/CD (GitHub Actions)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every
push and PR:

- **backend** — spins up pgvector-Postgres + Redis, runs `alembic upgrade head`
  (validating every migration), imports the app, boots it, and hits
  `/health/ready`.
- **frontend** — `npm ci` + `npm run build` (type-check + Vite build).
- **deploy** — only on push to `main`, only if both passed: `POST`s to the
  Render deploy hook. Vercel deploys itself via its Git integration.

Set up the deploy hook:

1. Render → `canvex-api` → **Settings → Deploy Hook**, copy the URL.
2. GitHub → repo **Settings → Secrets and variables → Actions → New secret**:
   `RENDER_DEPLOY_HOOK_URL` = that URL.

If the secret is absent, the deploy step is skipped (CI still runs), so PRs from
forks don't fail.

---

## 13.7  Migrations in production

Handled in code: [`backend/app/main.py`](backend/app/main.py)'s `lifespan` calls
`run_pending_migrations()` on boot when `settings.migrate_on_startup` is true
(automatic in production). A failed migration aborts startup, so a bad deploy
fails loudly instead of serving a broken schema. Never run
`alembic upgrade head` by hand in production after the first deploy.

---

## 13.8  Monitoring & uptime

- Render's dashboard has per-service logs (structured JSON — see Phase 12) and
  metrics. Enable alerts on health-check failures.
- Free option: [UptimeRobot](https://uptimerobot.com) → HTTP(s) monitor on
  `https://<your-api>/health/live` every 5 min. This also keeps Render's free
  tier from idling the service.

---

## 13.9  Final production checklist

- [ ] All secrets set in the platform dashboards, **nothing** in a committed file.
- [ ] `ENVIRONMENT=production` (disables SQL echo; the startup guard is armed).
- [ ] Migrations applied — logs show `database migrations up to date`.
- [ ] `CORS_ALLOW_ORIGINS` is the exact Vercel domain(s), not `*`.
- [ ] Rate limiting active (Phase 12) — `/auth/register` 429s under a burst.
- [ ] `GET /health/live` and `/health/ready` return 200.
- [ ] WebSockets connect over `wss://` (Render/Vercel terminate TLS).
- [ ] `API_BASE_URL` = the public backend URL (upload/invite links resolve).
- [ ] End-to-end: register → create channel → draw → AI response → audit log →
      export → branch → merge, on the public URLs.
