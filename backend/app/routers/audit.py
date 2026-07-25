from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import AsyncSessionLocal, get_db
from app.middleware.auth import get_current_user
from app.models.audit import ElementEvent
from app.models.element import WhiteboardElement
from app.models.enums import EventOperation, MemberRole
from app.models.session import Session, SessionEvent
from app.models.user import User
from app.schemas.audit import AuditPage, ElementEventRead, RestoreRequest, RestoreSummary, SessionRead
from app.services.audit import restore_element_to_timestamp, restore_page_to_timestamp
from app.services.elements import (
    assert_minimum_role,
    get_channel_membership_for_user,
    get_page_or_404,
)

router = APIRouter(tags=["audit"])


def event_read(event: ElementEvent, actor_display_name: str | None) -> ElementEventRead:
    return ElementEventRead(
        id=event.id,
        element_id=event.element_id,
        page_id=event.page_id,
        actor_id=event.actor_id,
        actor_display_name=actor_display_name,
        operation=event.operation,
        before_state=event.before_state,
        after_state=event.after_state,
        vector_clock=event.vector_clock,
        occurred_at=event.occurred_at,
    )


async def assert_page_role(db: AsyncSession, page_id: UUID, user_id: UUID, minimum_role: MemberRole) -> None:
    page = await get_page_or_404(db, page_id)
    membership = await get_channel_membership_for_user(db, page.channel_id, user_id)
    assert_minimum_role(membership, minimum_role)


async def get_element_for_audit(db: AsyncSession, element_id: UUID) -> WhiteboardElement:
    element = await db.get(WhiteboardElement, element_id)
    if element is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Element not found")
    return element


@router.get("/pages/{page_id}/audit", response_model=AuditPage)
async def get_page_audit(
    page_id: UUID,
    element_id: UUID | None = None,
    actor_id: UUID | None = None,
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: datetime | None = None,
    operation: EventOperation | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuditPage:
    await assert_page_role(db, page_id, current_user.id, MemberRole.VIEWER)

    conditions = [ElementEvent.page_id == page_id]
    if element_id is not None:
        conditions.append(ElementEvent.element_id == element_id)
    if actor_id is not None:
        conditions.append(ElementEvent.actor_id == actor_id)
    if from_ is not None:
        conditions.append(ElementEvent.occurred_at >= from_)
    if to is not None:
        conditions.append(ElementEvent.occurred_at <= to)
    if operation is not None:
        conditions.append(ElementEvent.operation == operation)

    total = await db.scalar(select(func.count()).select_from(ElementEvent).where(*conditions))
    rows = await db.execute(
        select(ElementEvent, User.display_name)
        .outerjoin(User, User.id == ElementEvent.actor_id)
        .where(*conditions)
        .order_by(ElementEvent.occurred_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return AuditPage(
        items=[event_read(event, display_name) for event, display_name in rows.all()],
        limit=limit,
        offset=offset,
        total=total or 0,
    )


@router.get("/elements/{element_id}/history", response_model=list[ElementEventRead])
async def get_element_history(
    element_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ElementEventRead]:
    element = await get_element_for_audit(db, element_id)
    await assert_page_role(db, element.page_id, current_user.id, MemberRole.VIEWER)

    rows = await db.execute(
        select(ElementEvent, User.display_name)
        .outerjoin(User, User.id == ElementEvent.actor_id)
        .where(ElementEvent.element_id == element_id)
        .order_by(ElementEvent.occurred_at.asc())
    )
    return [event_read(event, display_name) for event, display_name in rows.all()]


@router.post("/elements/{element_id}/restore", response_model=ElementEventRead)
async def restore_element(
    element_id: UUID,
    payload: RestoreRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ElementEventRead:
    element = await get_element_for_audit(db, element_id)
    await assert_page_role(db, element.page_id, current_user.id, MemberRole.EDITOR)
    await restore_element_to_timestamp(
        db,
        element=element,
        actor_id=current_user.id,
        target_timestamp=payload.target_timestamp,
    )
    await db.commit()
    await db.refresh(element)
    event = await db.get(ElementEvent, element.last_event)
    if event is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Restore event was not logged")
    return event_read(event, current_user.display_name)


@router.post("/pages/{page_id}/restore", response_model=RestoreSummary)
async def restore_page(
    page_id: UUID,
    payload: RestoreRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestoreSummary:
    await assert_page_role(db, page_id, current_user.id, MemberRole.EDITOR)
    restored_count = await restore_page_to_timestamp(
        db,
        page_id=page_id,
        actor_id=current_user.id,
        target_timestamp=payload.target_timestamp,
    )
    await db.commit()
    return RestoreSummary(restored_count=restored_count)


@router.get("/pages/{page_id}/sessions", response_model=list[SessionRead])
async def list_page_sessions(
    page_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SessionRead]:
    await assert_page_role(db, page_id, current_user.id, MemberRole.VIEWER)
    sessions = await db.scalars(
        select(Session)
        .where(Session.page_id == page_id)
        .order_by(Session.started_at.desc())
        .limit(50)
    )
    return [
        SessionRead(
            id=session.id,
            page_id=session.page_id,
            started_at=session.started_at,
            ended_at=session.ended_at,
        )
        for session in sessions
    ]


@router.get("/sessions/{session_id}/replay")
async def replay_session(
    session_id: UUID,
    speed: int = Query(default=1),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    # speed=0 means "no server pacing": dump every event immediately so the
    # client can drive its own playback clock (pause/resume/scrub).
    if speed not in {0, 1, 2, 4}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="speed must be one of 0, 1, 2, or 4")

    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    await assert_page_role(db, session.page_id, current_user.id, MemberRole.VIEWER)

    async def stream_events() -> AsyncIterator[str]:
        previous_event: SessionEvent | None = None
        async with AsyncSessionLocal() as replay_db:
            events = await replay_db.stream_scalars(
                select(SessionEvent)
                .where(SessionEvent.session_id == session_id)
                .order_by(SessionEvent.id.asc())
            )
            async for event in events:
                if previous_event is not None and speed > 0:
                    delay_s = (event.occurred_at - previous_event.occurred_at).total_seconds() / speed
                    if delay_s > 0:
                        await asyncio.sleep(min(delay_s, 2.0))
                yield json.dumps(
                    {
                        "id": event.id,
                        "event_type": event.event_type,
                        "payload": event.payload,
                        "actor_id": str(event.actor_id) if event.actor_id else None,
                        "occurred_at": event.occurred_at.isoformat(),
                    }
                ) + "\n"
                previous_event = event

    return StreamingResponse(stream_events(), media_type="application/x-ndjson")
