from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.enums import WebhookEventType


class WebhookCreate(BaseModel):
    target_url: str = Field(min_length=1, max_length=2048)
    event_types: list[WebhookEventType] = Field(min_length=1)

    @field_validator("target_url")
    @classmethod
    def require_http_url(cls, value: str) -> str:
        if not (value.startswith("http://") or value.startswith("https://")):
            raise ValueError("target_url must be an http:// or https:// URL")
        return value

    @field_validator("event_types")
    @classmethod
    def dedupe_event_types(cls, value: list[WebhookEventType]) -> list[WebhookEventType]:
        return sorted(set(value), key=lambda item: item.value)


class WebhookCreated(BaseModel):
    """Returned exactly once, at creation time — the signing secret is never
    retrievable again afterward, matching GitHub's webhook secret behavior."""

    id: UUID
    channel_id: UUID
    target_url: str
    event_types: list[str]
    is_active: bool
    signing_secret: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WebhookRead(BaseModel):
    id: UUID
    channel_id: UUID
    target_url: str
    event_types: list[str]
    is_active: bool
    created_at: datetime
    last_delivery_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)
