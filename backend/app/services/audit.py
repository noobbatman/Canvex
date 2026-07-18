from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import ElementEvent
from app.models.element import WhiteboardElement
from app.models.enums import ElementType, EventOperation
from app.models.session import Session, SessionEvent
from app.services.element_events import element_state, log_element_event


JsonState = dict[str, Any]


def _as_uuid(value: str | UUID | None) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    return UUID(value)


def apply_event_state(element: WhiteboardElement, state: JsonState, *, mark_deleted: bool | None = None) -> None:
    element.type = ElementType(str(state["type"]))
    element.transform = dict(state.get("transform") or {})
    element.style = dict(state.get("style") or {})
    element.content = dict(state.get("content") or {})
    element.locked_by = _as_uuid(state.get("locked_by"))
    element.is_deleted = bool(state.get("is_deleted", False) if mark_deleted is None else mark_deleted)
    element.updated_at = datetime.now(UTC)


async def get_state_event_at(
    db: AsyncSession,
    *,
    element_id: UUID,
    target_timestamp: datetime,
    include_deletes: bool,
) -> ElementEvent | None:
    conditions = [
        ElementEvent.element_id == element_id,
        ElementEvent.occurred_at <= target_timestamp,
    ]
    if not include_deletes:
        conditions.append(ElementEvent.operation != EventOperation.DELETE)
    return await db.scalar(
        select(ElementEvent)
        .where(*conditions)
        .order_by(ElementEvent.occurred_at.desc(), ElementEvent.id.desc())
        .limit(1)
    )


async def restore_element_to_timestamp(
    db: AsyncSession,
    *,
    element: WhiteboardElement,
    actor_id: UUID,
    target_timestamp: datetime,
) -> None:
    state_event = await get_state_event_at(
        db,
        element_id=element.id,
        target_timestamp=target_timestamp,
        include_deletes=False,
    )
    if state_event is None or state_event.after_state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No restorable state found for element")

    before_state = element_state(element)
    apply_event_state(element, state_event.after_state, mark_deleted=False)
    await db.flush()
    await log_element_event(
        db,
        element=element,
        actor_id=actor_id,
        operation=EventOperation.RESTORE,
        before_state=before_state,
        after_state=element_state(element),
    )


async def restore_page_to_timestamp(
    db: AsyncSession,
    *,
    page_id: UUID,
    actor_id: UUID,
    target_timestamp: datetime,
) -> int:
    element_ids = await db.scalars(select(ElementEvent.element_id).where(ElementEvent.page_id == page_id).distinct())
    restored_count = 0

    for element_id in element_ids:
        state_event = await get_state_event_at(
            db,
            element_id=element_id,
            target_timestamp=target_timestamp,
            include_deletes=True,
        )

        element = await db.get(WhiteboardElement, element_id)
        if element is None:
            continue

        before_state = element_state(element)
        if state_event is None:
            # Every event for this element is after the target timestamp: it
            # did not exist at that point in time, so a page-level restore
            # removes it (soft delete, logged below like any other change).
            if element.is_deleted:
                continue
            element.is_deleted = True
            element.updated_at = datetime.now(UTC)
        elif state_event.operation == EventOperation.DELETE:
            element.is_deleted = True
            element.updated_at = datetime.now(UTC)
        elif state_event.after_state is not None:
            apply_event_state(element, state_event.after_state, mark_deleted=False)
        else:
            continue

        await db.flush()
        after_state = element_state(element)
        if before_state == after_state:
            continue
        await log_element_event(
            db,
            element=element,
            actor_id=actor_id,
            operation=EventOperation.RESTORE,
            before_state=before_state,
            after_state=after_state,
        )
        restored_count += 1

    return restored_count


async def get_active_session(db: AsyncSession, page_id: UUID) -> Session | None:
    return await db.scalar(
        select(Session)
        .where(Session.page_id == page_id, Session.ended_at.is_(None))
        .order_by(desc(Session.started_at))
        .limit(1)
    )


async def get_or_create_active_session(db: AsyncSession, page_id: UUID) -> Session:
    session = await get_active_session(db, page_id)
    if session is not None:
        return session

    await db.execute(
        insert(Session)
        .values(page_id=page_id)
        .on_conflict_do_nothing(
            index_elements=[Session.page_id],
            index_where=Session.ended_at.is_(None),
        )
    )
    await db.flush()
    session = await get_active_session(db, page_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not create active session",
        )
    return session


async def record_session_event(
    db: AsyncSession,
    *,
    session_id: UUID,
    page_id: UUID,
    event_type: str,
    payload: dict[str, Any],
    actor_id: UUID | None,
) -> SessionEvent:
    event = SessionEvent(
        session_id=session_id,
        page_id=page_id,
        event_type=event_type,
        payload=payload,
        actor_id=actor_id,
    )
    db.add(event)
    await db.flush()
    return event


async def end_active_session(db: AsyncSession, page_id: UUID) -> Session | None:
    session = await db.scalar(
        select(Session)
        .where(Session.page_id == page_id, Session.ended_at.is_(None))
        .order_by(desc(Session.started_at))
        .limit(1)
    )
    if session is None:
        return None
    session.ended_at = datetime.now(UTC)
    await db.flush()
    return session
