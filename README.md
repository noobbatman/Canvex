# Canvex

Canvex is a collaborative whiteboard project built around FastAPI, PostgreSQL, Redis, and React. The backend uses PostgreSQL JSONB for flexible canvas element state, an append-only event log for auditability, and pgvector for later semantic search.

## Current Phase

Phases 0–10 are implemented: audit log querying, session replay, Git-style board branching, the AI pipeline, plus the Phase 10 analytics, webhooks, export, and share-link features. Phase 11 (complete UI) is partially implemented; Phases 12–13 (production hardening, deployment) have not started.

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
