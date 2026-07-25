# Canvex

Canvex is a collaborative whiteboard project built around FastAPI, PostgreSQL, Redis, and React. The backend uses PostgreSQL JSONB for flexible canvas element state, an append-only event log for auditability, and pgvector for later semantic search.

## Current Phase

Phases 0–10 are implemented: audit log querying, session replay, Git-style board branching, the AI pipeline, plus the Phase 10 analytics, webhooks, export, and share-link features. Phase 11 (complete UI) is complete — member/role management with online-now dots, invite create/join, audit log viewer with click-to-highlight, branch/diff/merge UI, session replay player with pause/resume and timeline scrubbing, freehand pen, math input, image upload, undo/redo, zoom, canvas analytics, and PNG/PDF export are all reachable from the UI. Phase 12 (production hardening) is complete. Phase 13 (deployment) is done: the code and config artifacts are in place (`render.yaml` Blueprint, `backend/Procfile`, `frontend/vercel.json`, `.github/workflows/deploy.yml` CI/CD, boot-time migrations, provider-URL normalisation) — see [DEPLOYMENT.md](DEPLOYMENT.md) for the step-by-step — and the app is deployed on Render (backend + workers + Postgres + Redis) and Vercel (frontend).

Since deployment, three feature sets have landed — **Google and institutional-email sign-in**, **instant synchronous AI question-answering**, and **multimodal handwriting support** (the AI reads the canvas) — documented in the dated sections at the end of this file.

- SQLAlchemy 2.0 async models
- Alembic migration setup
- Initial PostgreSQL schema migration
- Seed script with users, channel, pages, elements, and element events
- Password hashing with bcrypt
- JWT access tokens and rotating refresh tokens
- Auth endpoints for registration, login, refresh, logout, and current user lookup
- Channel CRUD
- Channel membership RBAC
- Invite generation and acceptance
- Whiteboard page create/list/update/soft-delete endpoints
- Element create/list/update/soft-delete endpoints
- Element JSONB type and text search filters
- Append-only element event logging for every element mutation
- Element-level permission checks for role-specific edit/delete locks
- WebSocket room manager for page-scoped collaboration
- Authenticated `WS /ws/{page_id}` endpoint
- WebSocket element create/update/delete operations backed by the Phase 4 event log
- Redis-backed element locks with disconnect cleanup
- Cursor presence broadcast and `GET /pages/{id}/presence`
- React + Fabric.js canvas UI with select, rectangle, ellipse, and text tools
- WebSocket client for element ops, locks, and live cursors
- Channel/page shell with authentication flow
- Yjs document per whiteboard page
- IndexedDB persistence for local page element state
- Offline operation queue for create/update/delete element operations
- Online/offline detection with a visible workspace status chip
- Reconnect replay of queued operations through the existing authenticated WebSocket
- `protocol: "canvas"` marker on realtime messages for future protocol expansion
- Page audit endpoint with filters for element, actor, operation, and timestamp range
- Element history endpoint with before/after states and actor attribution
- Point-in-time restore for individual elements and whole pages
- WebSocket session recording for element operations, locks, unlocks, and cursor movement
- Session replay endpoint that streams recorded events as newline-delimited JSON
- WebSocket AI trigger detection for math, questions, images, closed shapes, and explicit `/ai` prompts
- ARQ-backed `ai-worker` service for canvas analysis and text embedding jobs
- Gemini integration with deterministic local fallback when `GEMINI_API_KEY` is not configured
- AI interaction ledger and `GET /pages/{page_id}/ai-log`
- AI feedback endpoint: `POST /ai/{interaction_id}/feedback`
- Semantic search endpoint: `GET /search?q=...`
- Canvas analytics: `GET /pages/{page_id}/analytics` with edit heatmap buckets, per-user participation, and AI usage stats
- Webhook registration per channel and HMAC-SHA256 signed delivery with exponential-backoff retries via a dedicated `webhook-worker`
- PNG/PDF export: `GET /pages/{page_id}/export?format=png|pdf` (server-side Pillow renderer, off the event loop)
- Read-only share links: `POST /pages/{page_id}/share` JWT tokens, a `/view/{token}` viewer page, and a receive-only WebSocket mode
- Automatic access-token refresh in the frontend API client (single-flight, rotation-aware)
- WebSocket auto-reconnect with capped backoff, immediate reconnect when the browser comes back online
- Member management UI: role badges, admin role changes, member removal, invite-code creation and join-by-code
- Audit log viewer panel with operation/member filters and pagination
- Branches shown indented under their parent page, with hover-to-branch, diff modal (added/modified/deleted), and merge with strategy selection
- Session replay player modal: session picker, 1×/2×/4× speed, streamed playback onto a read-only canvas with live cursors
- One-click PNG/PDF export and sign-out from the right-edge action rail
- Math input tool (Σ in the toolbar): typed equations land as math elements and trigger the AI solver
- Audit rows are clickable — the referenced element gets a dashed halo flash on the canvas
- Replay timeline scrubbing: after playback, drag the slider to re-render the canvas at any event
- Canvas analytics modal: stat tiles, sequential-indigo edit heatmap, per-user participation bars, AI usage by trigger
- Freehand drawing: pen (3px), pencil (fine 1.5px), and highlighter (thick translucent) — all PencilBrush strokes converted to polyline `stroke` elements that sync like any other element
- Highlighter options popover: its own colour set (independent of the pen) and an 8–40px thickness slider
- Manual eraser with an options popover (iOS Markup-style): **Whole** mode removes whole elements, **Partial** mode rubs out only the covered span of a pen stroke (splitting it into fragments); an 8–80px size slider drives a live dashed cursor circle, plus "auto switch back to last tool". All erasures sync and are undoable.
- Image upload: `POST /uploads` (5 MB PNG/JPEG/WebP/GIF limit, served from `/uploads/`) with an Image toolbar button that places the picture on the canvas
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z) for create, delete, and move/scale/rotate — undone changes sync to collaborators through the normal element ops
- Zoom: toolbar buttons + Ctrl+scroll (25%–400%), with remote cursors projected correctly at any zoom level
- Members show a green "online now" dot backed by live WebSocket connections (`GET /pages/{id}/presence` now returns user ids)
- Replay playback is client-paced (server `speed=0` dump): true pause/resume plus scrubbing at any time
- Rate limiting (Phase 12): 10 req/s per IP general API, 5/min registration, 10/min login, 20/min per user for semantic search and uploads, 100/min WebSocket ops per connection (cursor moves budgeted separately)
- Structured JSON logging: every line is one JSON object with timestamp, level, request ID (returned as `X-Request-ID`), and user ID when authenticated
- Security headers on every response (nosniff, DENY framing, HSTS, restrictive CSP outside `/docs`); unhandled errors return a generic 500 carrying the request ID, with the traceback only in server logs
- Input hardening: 100KB cap on element JSONB payloads (REST and WebSocket paths share the validator), future-dated invite expiry enforcement
- `/health/live` and `/health/ready` (checks PostgreSQL + Redis, 503 when degraded); SQLAlchemy pool sized 10+20 overflow
- Startup refuses to boot in `ENVIRONMENT=production` with the default JWT secret or wildcard CORS
- EXPLAIN-driven indexes: `sessions(page_id, started_at DESC)` and a partial expression index on `whiteboard_elements(content->>'_origin_id')` for branch diffs

## Local Full-Stack Setup

The backend, AI worker, webhook worker, and frontend run as separate development processes:

- FastAPI API: `http://localhost:8000`
- Vite frontend: `http://localhost:5173`
- PostgreSQL: Docker service `postgres`
- Redis: Docker service `redis`

Start infrastructure first, then run the backend, the workers, and the frontend in separate terminals.

## Local Backend Setup

1. Copy `backend/.env.example` to `backend/.env`.
2. Start PostgreSQL and Redis:

```powershell
docker compose up -d postgres redis
```

3. Install Python dependencies in the shared project virtual environment, if needed:

```powershell
C:\Users\Istiak\Desktop\Projects\.venv\Scripts\python -m pip install -r backend\requirements.txt
```

4. Run migrations:

```powershell
cd backend
alembic upgrade head
```

5. Seed development data:

```powershell
python scripts/seed.py
```

6. Start the API:

```powershell
uvicorn app.main:app --reload
```

The smoke test endpoint is `GET /health`.

7. Start the AI worker in a separate terminal:

```powershell
cd backend
arq app.workers.ai_worker.WorkerSettings
```

If `GEMINI_API_KEY` is empty, Canvex still creates AI ledger rows and local deterministic responses for development.

8. Start the webhook delivery worker in a separate terminal (only needed if channel webhooks are registered):

```powershell
cd backend
arq app.workers.webhook_worker.WorkerSettings
```

## Local Frontend Setup

1. Copy `frontend/.env.example` to `frontend/.env` and adjust `VITE_API_URL` if needed.
2. Install frontend dependencies:

```powershell
cd frontend
npm install
```

3. Start the Vite dev server:

```powershell
npm run dev
```

Open `http://localhost:5173` in the browser. The frontend expects the API URL from `frontend/.env`:

```text
VITE_API_URL=http://localhost:8000
```

## Useful Checks

Backend:

```powershell
C:\Users\Istiak\Desktop\Projects\.venv\Scripts\python -m ruff check backend
C:\Users\Istiak\Desktop\Projects\.venv\Scripts\python backend\scripts\check_phase5_ws.py
```

Frontend:

```powershell
cd frontend
npm run lint
npm run build
```

## Phase 7 Notes

- Element create/update/delete operations are persisted through the backend WebSocket route and still write to the append-only event log.
- Create acknowledgements use a client operation id so rapid local creates are matched to the correct Fabric object.
- The canvas stores a local Yjs `elements` map in IndexedDB for each page, so cached elements can be restored when the network is unavailable.
- While offline, element operations are queued locally. When the browser reconnects and the page WebSocket opens, queued operations are replayed with their original vector clocks.
- The installed `y-websocket` dependency is reserved for a later binary Yjs transport. The current Phase 6 implementation keeps the existing JSON WebSocket contract and adds a `protocol` field so protocol routing can evolve without breaking canvas messages.
- `GET /pages/{page_id}/audit` returns a paginated event log with optional filters.
- `GET /elements/{element_id}/history` returns the full lifecycle for one element.
- `POST /elements/{element_id}/restore` and `POST /pages/{page_id}/restore` accept `target_timestamp`.
- `GET /pages/{page_id}/sessions` lists recent replayable sessions.
- `GET /sessions/{session_id}/replay?speed=1|2|4` streams replay events as `application/x-ndjson`.

## Phase 8 Notes

- `POST /pages/{page_id}/branch` forks a parent page into a branch and copies active elements with `content._origin_id` lineage metadata.
- `GET /pages/{page_id}/diff` compares a branch against its parent and returns added, modified, and deleted elements.
- `POST /pages/{page_id}/merge` merges a branch back into its parent with `ours` or `theirs` strategy.
- Branch diff comparison includes element type, transform, style, and content while ignoring `_origin_id`.
- Merge writes element events for each parent element created, updated, or deleted.

## Phase 9 Notes

- Browser canvas snapshots are attached to qualifying WebSocket element operations.
- The API enqueues ARQ jobs instead of calling Gemini inside the WebSocket request path.
- The worker writes every AI attempt to `ai_interactions`, creates an AI text element on success, computes an embedding, and publishes an `ai:response` message through Redis.
- Connected WebSocket clients subscribe to Redis AI response messages and render generated answers live.
- Feedback rows are injected into future prompts per channel so repeated corrections improve responses.

## Phase 10 Notes

- Every element mutation upserts a `canvas_analytics` row keyed by `(page, user, day, 200px region bucket)`; WebSocket connection time is accumulated per user per day on disconnect.
- `GET /pages/{page_id}/analytics` returns the current-month edit heatmap, per-user participation (element counts plus tracked or estimated active seconds), and AI usage grouped by trigger type.
- `POST /channels/{channel_id}/webhooks` returns the signing secret once; deliveries are HMAC-SHA256 signed (`X-Canvex-Signature`) and retried with 5s/25s/125s backoff by the `webhook-worker`.
- `GET /pages/{page_id}/export?format=png|pdf` renders the page server-side with Pillow in a worker thread.
- `POST /pages/{page_id}/share` issues a stateless read-only JWT; `/view/{token}` renders the page and follows live updates over a receive-only WebSocket. Share viewers cannot send mutations and do not keep replay sessions alive.

## Audit Fixes (2026-07-17)

A full-codebase review against the implementation plan fixed ten bugs:

- Frontend: the stored refresh token is now actually used — a single-flight axios interceptor refreshes on 401 and retries, so sessions survive past the 15-minute access-token expiry.
- Frontend: the page WebSocket auto-reconnects with capped exponential backoff and reconnects immediately on the browser `online` event, so queued offline operations reliably replay.
- Frontend: remote element locks now expire client-side after the lock's TTL instead of leaving elements frozen until the locker disconnects.
- Frontend: text width, font size, and sticky background color are persisted in element content, so collaborators, the share viewer, and exports render them faithfully; rect/ellipse dimensions are persisted too.
- Frontend: remote cursors are pruned after ~6s of inactivity to match the server-side TTL.
- Backend: `cursor:move` events are recorded to `session_events`, making the existing replay claim true.
- Backend: failed AI jobs roll back before writing their `failed` ledger row, so DB errors can no longer lose the `ai_interactions` entry.
- Backend: PNG/PDF export rendering runs off the event loop.
- Backend: page point-in-time restore soft-deletes elements that did not yet exist at the target timestamp.
- Backend: REST element update/delete now respect Redis element locks (423), matching the WebSocket path.

## Deployment (2026-07-20)

- Deployed to production: FastAPI backend + AI worker + webhook worker + managed PostgreSQL + Redis on **Render** (via the `render.yaml` Blueprint), and the React frontend on **Vercel**.
- Database URL normalisation rewrites `postgres://` / `postgresql://` (what Render/Railway hand out) to `postgresql+asyncpg://` and strips `sslmode`, so the same code runs locally and in production.
- Migrations run automatically on boot in production (FastAPI lifespan → `alembic upgrade head`); a failed migration aborts startup so a bad deploy fails loudly.
- CORS is configured from `CORS_ALLOW_ORIGINS` (comma-separated Vercel domain(s)); the app refuses to boot in `ENVIRONMENT=production` with a wildcard origin or the default JWT secret.
- External managed Postgres (e.g. **Supabase**, for a persistent free tier with pgvector) is supported via `DATABASE_SSL=require` — the app engine and Alembic both apply it. See [DEPLOYMENT.md](DEPLOYMENT.md) → *Supabase for Postgres*.
- See [DEPLOYMENT.md](DEPLOYMENT.md) for the full first-to-last guide, including the Render/Vercel dashboard steps and the production checklist.

## Social & Institutional Sign-In (2026-07-22)

- **Sign in with Google** — Google Identity Services renders the button in the frontend; the backend verifies the Google ID token server-side with `google-auth` and issues the normal Canvex token pair. `POST /auth/google`.
- The Google **client ID lives only on the backend** (`GOOGLE_CLIENT_ID`) and is served to the frontend via the public `GET /auth/config`, so it's configured in one place. Blank → the button stays hidden.
- **Institutional Login** — `POST /auth/institutional/register` gates email/password registration to institutional domains. Any `.edu` / `.ac` domain (`.edu`, `.edu.bd`, `.ac`, `.ac.uk`, `.ac.bd`, …) is always accepted; `INSTITUTIONAL_EMAIL_DOMAINS` only *adds* further domains, it never restricts. The domain is checked on account creation; existing accounts always sign in.
- `users.password_hash` is now nullable (OAuth-only accounts have no password) with a unique `google_sub` link column — accounts link by verified email. Migration `202607220001`.
- Config lives on the backend only; see [DEPLOYMENT.md §13.5b](DEPLOYMENT.md) for the Google Cloud Console setup.

## Instant, Multimodal AI Answers (2026-07-22)

- **Synchronous ask endpoint** `POST /pages/{page_id}/ask` — runs Gemini (or the deterministic local fallback) *inline* and returns the answer plus the created canvas element in the HTTP response. No ARQ worker or Redis queue in the path, so answers appear immediately even if the AI worker isn't running. The "Ask Canvex" box now uses this and renders the reply at the current view with a "Thinking…" state.
- **Reads your handwriting** — the Ask flow attaches a downscaled (≤1536px) PNG snapshot of the current canvas view; the backend forwards it to the Gemini vision model and the prompt instructs it to interpret handwriting, equations, diagrams, and drawings. Falls back to text-only if the canvas can't be exported (e.g. a cross-origin image taints it).
- **Resilient** — a Gemini error (bad key/model/network) degrades to the local fallback so the user always gets an instant answer; the UI reports the source (real Gemini vs offline/local mode).
- Config: set `GEMINI_API_KEY` for real answers and `GEMINI_VISION_MODEL` to a current multimodal model (e.g. `gemini-3.5-flash`); blank key → local development fallback. The original canvas-trigger path (typing `?`, `/ai`, dropping an image) still enqueues to the AI worker.

## AI Panel & Answer Placement (2026-07-22)

- Redesigned the "Ask Canvex" panel: removed the sample-question hint, added a cleaner ask box with a "Thinking…" state, and premium answer cards (a "Canvex AI" badge, a "local mode" badge when the real model wasn't used, and a readable answer).
- **Answers are no longer auto-placed on the canvas.** `POST /pages/{page_id}/ask` now returns the answer text only; the panel displays it and each answer has an **Add to canvas** action, so the user chooses what lands on the page.
- Added answers become **first-class editable text elements** — drag to move, corner handles to resize, Delete/eraser to remove — created through the standard element path, so they sync to collaborators and are undoable. Once added, the card shows "Added to canvas".
- The panel now has a bounded height with a **scrollable answer list** (header + ask box stay pinned), so the Ask box no longer gets pushed off-screen as answers accumulate; the panel keeps the last 20 answers.

## Page-Scan AI — Floating "Solve page" Button (2026-07-22)

Replaces the type-a-question dialog above with a single-action model.

- The "Ask Canvex" dialog (text box, answer cards, per-answer feedback) is **removed**. In its place is one **floating "Solve page" button**.
- Pressing it scans the **whole page**: the frontend snapshots the current view and calls the new `POST /pages/{page_id}/solve`, which sends the image to the Gemini vision model and returns an answer for **every** problem/question/equation it finds — each with a normalised `x`/`y` position in the image.
- The frontend drops each answer as an **editable text element next to its problem** (using the returned position; falls back to a neat stack when no position is given). Answers are normal elements — drag, resize, delete, sync, undo.
- Synchronous (no AI worker). Needs `GEMINI_API_KEY` + a vision `GEMINI_VISION_MODEL` (e.g. `gemini-3.5-flash`); without them the button reports that a vision model is required. Robust JSON parsing tolerates code fences and 0–1 / 0–100 / 0–1000 coordinate scales.

## Audit Fixes (2026-07-22)

A code review flagged correctness and security issues; the contained ones are fixed (larger architectural items — multi-instance realtime, object storage for uploads, SSRF-safe webhooks, webhook durability, cookie-based auth, pinned deps, CI test suites — are tracked separately):

- **Google-only login no longer 500s.** Password login against an OAuth account (NULL `password_hash`) now falls back to the dummy hash and returns a clean 401 instead of crashing inside passlib.
- **Branch lineage survives edits.** Element updates preserve backend-managed content keys (`_origin_id`, `source`, `interaction_id`) even when the client omits them, so moving/editing a branched element no longer breaks diff/merge.
- **Institutional-email check tightened.** `edu`/`ac` must be the TLD or second level (`mit.edu`, `nsu.edu.bd`, `du.ac.bd`); `edu.attacker.com` is now rejected (backend + frontend).
- **Atomic element locks.** Lock acquisition uses Redis `SET NX`, so two users can't both win the same lock (was a racy GET-then-SET).
- **Refresh-token rotation locked.** The refresh row is read `FOR UPDATE`, so concurrent refreshes serialise instead of both rotating.
- **Resource-exhaustion caps.** AI snapshot payloads are size-capped; the 100KB element-payload limit now counts UTF-8 bytes, not Unicode characters.
- **Stricter production guard.** Startup rejects a JWT secret under 32 chars (blank/weak/default) and warns when `API_BASE_URL` is still localhost in production.

## Audit Fixes — Follow-up Batch (2026-07-22)

- **Deleting a used channel works.** Migration `202607220002` adds `ON DELETE CASCADE` to the page-referencing FKs (`element_events`, `sessions`, `ai_interactions`) and `ai_feedback → ai_interactions` (and `SET NULL` for `review_comments.snapshot_event`), so a channel with history no longer 500s on delete.
- **Logout revokes the freshest token.** `handleLogout` reads the current refresh token from storage (the interceptor rotates it there) instead of stale React state, so signing out after a background refresh actually revokes the live token.
- **Webhook SSRF guard.** Delivery resolves the target host and refuses any private/loopback/link-local/cloud-metadata address ([`core/ssrf.py`](backend/app/core/ssrf.py)); creation rejects obvious internal literals; the delivery client no longer follows redirects.
- **Token redaction in logs.** The request logger redacts the share JWT in `/view/{token}` and the join code in `/invites/{code}` so bearer secrets don't land in access logs.
- **Export/upload resource caps.** Export tiles and the page canvas are size-clamped (`MAX_TILE_PX`/`MAX_CANVAS_PX`), so arbitrary element dimensions can't request an enormous image; uploads are validated by **actual image content** (Pillow), not the client `Content-Type`, with a dimension cap.
- **Deploy/DB hygiene.** `requirements.txt` is now fully pinned for reproducible builds; migration `202607220003` drops the unused branch expression index; the stale Phase-5 presence check now expects 2 connected users.

> Still open (need a decision / larger effort, tracked for later): multi-instance realtime (Redis pub/sub), uploads → object storage/persistent disk, cookie-based auth, durable/idempotent webhooks, `CREATE INDEX CONCURRENTLY` migrations, a CI test suite, and the npm-11 lockfile quirk with fabric's optional native `canvas` dep.
