from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.whiteboard import ElementRead, PageRead


class ShareLinkCreate(BaseModel):
    expires_in_hours: int = Field(default=168, ge=1, le=24 * 30)  # default 7 days, max 30


class ShareLinkRead(BaseModel):
    token: str
    share_url: str
    expires_at: datetime


class SharedPageView(BaseModel):
    page: PageRead
    elements: list[ElementRead]
