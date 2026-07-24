import logging
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text

from app.config import settings
from app.core.logging import setup_logging
from app.core.migrations import run_pending_migrations
from app.core.rate_limit import limiter
from app.db.session import AsyncSessionLocal
from app.middleware.observability import RequestContextMiddleware, SecurityHeadersMiddleware
from app.routers.ai import router as ai_router
from app.routers.analytics import router as analytics_router
from app.routers.audit import router as audit_router
from app.routers.auth import router as auth_router
from app.routers.channels import router as channels_router
from app.routers.export import router as export_router
from app.routers.share import router as share_router
from app.routers.uploads import UPLOADS_DIR, router as uploads_router
from app.routers.webhooks import router as webhooks_router
from app.routers.whiteboard import router as whiteboard_router
from app.routers.ws import router as ws_router
from app.services.redis import get_redis

setup_logging()
logger = logging.getLogger("canvex")


def assert_production_config() -> None:
    """Crash loudly at startup rather than run production with dev secrets
    or wide-open CORS (plan 12.9 / 13.5)."""
    if settings.environment != "production":
        return
    problems = []
    # len < 32 catches the dev default, a blank value, and any weak short secret.
    if len(settings.jwt_secret_key) < 32:
        problems.append("JWT_SECRET_KEY must be a strong secret of at least 32 characters")
    if "*" in settings.cors_allow_origins:
        problems.append('CORS_ALLOW_ORIGINS must not contain "*" in production')
    if problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
    if settings.api_base_url.startswith(("http://localhost", "http://127.")):
        # Not fatal (don't block a deploy), but upload/invite links will be broken.
        logger.warning(
            "API_BASE_URL is still %s in production — upload and invite links will be wrong",
            settings.api_base_url,
        )


assert_production_config()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Plan 13.7: apply pending migrations on boot (production restarts on each
    # deploy, so schema changes ship automatically). Run in a worker thread —
    # alembic's env.py starts its own asyncio loop. Failures propagate and
    # abort startup so a bad migration fails the deploy loudly.
    if settings.migrate_on_startup:
        logger.info("applying database migrations on startup")
        await anyio.to_thread.run_sync(run_pending_migrations)
        logger.info("database migrations up to date")
    yield


app = FastAPI(title="Canvex API", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Middleware wraps in REVERSE add order (last added = outermost). CORS must
# be outermost so (a) preflight OPTIONS short-circuit before the rate limiter
# and (b) 429s and other middleware-generated responses still carry CORS
# headers — otherwise the browser reports an opaque CORS failure instead of
# the actual status.
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Plan 12.6: log the full traceback, never leak it to the client, and
    return the request ID so users can report it.

    This runs in Starlette's outermost error layer — OUTSIDE every middleware
    — so the request-id contextvar is already reset (read it from
    request.state instead) and no middleware will decorate the response:
    CORS and the id header have to be applied by hand or the frontend can't
    read the error at all."""
    request_id = getattr(request.state, "request_id", "") or ""
    logger.exception(
        "unhandled exception",
        extra={"path": request.url.path, "method": request.method, "request_id": request_id},
    )
    response = JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
    )
    if request_id:
        response.headers["X-Request-ID"] = request_id
    origin = request.headers.get("origin")
    if origin and origin in settings.cors_allow_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"
    return response


app.include_router(auth_router)
app.include_router(channels_router)
app.include_router(whiteboard_router)
app.include_router(audit_router)
app.include_router(ai_router)
app.include_router(analytics_router)
app.include_router(webhooks_router)
app.include_router(export_router)
app.include_router(share_router)
app.include_router(uploads_router)
app.include_router(ws_router)

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


@app.get("/health")
@limiter.exempt
async def health() -> dict[str, str]:
    # Kept for backward compatibility; /health/live is the canonical probe.
    return {"status": "ok"}


@app.get("/health/live")
@limiter.exempt
async def health_live() -> dict[str, str]:
    return {"status": "alive"}


@app.get("/health/ready")
@limiter.exempt
async def health_ready() -> JSONResponse:
    checks: dict[str, str] = {}
    healthy = True
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception:
        logger.exception("readiness check failed: postgres")
        checks["postgres"] = "unavailable"
        healthy = False
    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception:
        logger.exception("readiness check failed: redis")
        checks["redis"] = "unavailable"
        healthy = False
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ready" if healthy else "degraded", "checks": checks},
    )
