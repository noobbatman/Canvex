from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers.ai import router as ai_router
from app.routers.analytics import router as analytics_router
from app.routers.audit import router as audit_router
from app.routers.auth import router as auth_router
from app.routers.channels import router as channels_router
from app.routers.export import router as export_router
from app.routers.share import router as share_router
from app.routers.webhooks import router as webhooks_router
from app.routers.whiteboard import router as whiteboard_router
from app.routers.ws import router as ws_router

app = FastAPI(title="Canvex API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(channels_router)
app.include_router(whiteboard_router)
app.include_router(audit_router)
app.include_router(ai_router)
app.include_router(analytics_router)
app.include_router(webhooks_router)
app.include_router(export_router)
app.include_router(share_router)
app.include_router(ws_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
