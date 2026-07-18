from __future__ import annotations

import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.middleware.rbac import require_channel_role
from app.models.channel import Channel, ChannelMember
from app.models.enums import MemberRole
from app.models.webhook import Webhook
from app.schemas.webhook import WebhookCreate, WebhookCreated, WebhookRead

router = APIRouter(tags=["webhooks"])


@router.post(
    "/channels/{channel_id}/webhooks",
    response_model=WebhookCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_webhook(
    channel_id: UUID,
    payload: WebhookCreate,
    _: ChannelMember = Depends(require_channel_role(MemberRole.ADMIN)),
    db: AsyncSession = Depends(get_db),
) -> Webhook:
    channel = await db.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")

    webhook = Webhook(
        channel_id=channel_id,
        target_url=payload.target_url,
        signing_secret=secrets.token_hex(32),
        event_types=[event.value for event in payload.event_types],
    )
    db.add(webhook)
    await db.commit()
    await db.refresh(webhook)
    return webhook


@router.get("/channels/{channel_id}/webhooks", response_model=list[WebhookRead])
async def list_webhooks(
    channel_id: UUID,
    _: ChannelMember = Depends(require_channel_role(MemberRole.ADMIN)),
    db: AsyncSession = Depends(get_db),
) -> list[Webhook]:
    webhooks = await db.scalars(
        select(Webhook).where(Webhook.channel_id == channel_id).order_by(Webhook.created_at.desc())
    )
    return list(webhooks.all())
