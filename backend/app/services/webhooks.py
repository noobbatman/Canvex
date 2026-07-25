from __future__ import annotations

from typing import Any
from uuid import UUID

from arq.connections import RedisSettings, create_pool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.page import WhiteboardPage
from app.models.webhook import Webhook

_arq_pool = None


def redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(settings.redis_url)


async def _get_arq_pool():
    global _arq_pool
    if _arq_pool is None:
        _arq_pool = await create_pool(redis_settings())
    return _arq_pool


async def _enqueue_deliveries(webhooks: list[Webhook], *, event_type: str, payload: dict[str, Any]) -> None:
    if not webhooks:
        return
    pool = await _get_arq_pool()
    for webhook in webhooks:
        await pool.enqueue_job(
            "deliver_webhook",
            webhook_id=str(webhook.id),
            event_type=event_type,
            payload=payload,
        )


async def dispatch_webhook_event_for_page(
    db: AsyncSession,
    *,
    page_id: UUID,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Find active webhooks subscribed to event_type for the channel that owns
    this page, and enqueue one delivery job per subscriber."""
    webhooks = (
        await db.scalars(
            select(Webhook)
            .join(WhiteboardPage, WhiteboardPage.channel_id == Webhook.channel_id)
            .where(
                WhiteboardPage.id == page_id,
                Webhook.is_active.is_(True),
                Webhook.event_types.any(event_type),
            )
        )
    ).all()
    await _enqueue_deliveries(list(webhooks), event_type=event_type, payload=payload)


async def dispatch_webhook_event_for_channel(
    db: AsyncSession,
    *,
    channel_id: UUID,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    webhooks = (
        await db.scalars(
            select(Webhook).where(
                Webhook.channel_id == channel_id,
                Webhook.is_active.is_(True),
                Webhook.event_types.any(event_type),
            )
        )
    ).all()
    await _enqueue_deliveries(list(webhooks), event_type=event_type, payload=payload)
