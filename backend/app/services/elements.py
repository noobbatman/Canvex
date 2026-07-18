from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.middleware.rbac import ROLE_RANK
from app.models.channel import ChannelMember
from app.models.element import ElementPermission, WhiteboardElement
from app.models.enums import EventOperation, MemberRole
from app.models.page import WhiteboardPage
from app.schemas.whiteboard import ElementCreate, ElementUpdate
from app.services.analytics import record_canvas_analytics
from app.services.element_events import element_state, log_element_event


async def get_page_or_404(db: AsyncSession, page_id: UUID) -> WhiteboardPage:
    page = await db.get(WhiteboardPage, page_id)
    if page is None or page.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")
    return page


async def get_element_or_404(db: AsyncSession, element_id: UUID) -> WhiteboardElement:
    element = await db.get(WhiteboardElement, element_id)
    if element is None or element.is_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Element not found")
    return element


async def get_channel_membership_for_user(db: AsyncSession, channel_id: UUID, user_id: UUID) -> ChannelMember:
    membership = await db.scalar(
        select(ChannelMember).where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not a member of this channel")
    return membership


def assert_minimum_role(membership: ChannelMember, minimum_role: MemberRole) -> None:
    if ROLE_RANK[membership.role] < ROLE_RANK[minimum_role]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient channel role")


async def assert_can_mutate_element(
    db: AsyncSession,
    element: WhiteboardElement,
    role: MemberRole,
    *,
    deleting: bool = False,
) -> None:
    permission = await db.get(ElementPermission, {"element_id": element.id, "role": role})
    if permission is None:
        return
    if not permission.can_edit:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Element is locked for your role")
    if deleting and not permission.can_delete:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Element cannot be deleted by your role")


async def create_element_for_page(
    db: AsyncSession,
    *,
    page_id: UUID,
    payload: ElementCreate,
    actor_id: UUID | None,
) -> WhiteboardElement:
    element = WhiteboardElement(
        page_id=page_id,
        created_by=actor_id,
        type=payload.type,
        transform=payload.transform,
        style=payload.style,
        content=payload.content,
    )
    db.add(element)
    await db.flush()
    await log_element_event(
        db,
        element=element,
        actor_id=actor_id,
        operation=EventOperation.CREATE,
        before_state=None,
        after_state=element_state(element),
        vector_clock=payload.vector_clock,
    )
    await record_canvas_analytics(db, page_id=element.page_id, user_id=actor_id, transform=element.transform)
    return element


async def update_element_state(
    db: AsyncSession,
    *,
    element: WhiteboardElement,
    payload: ElementUpdate,
    actor_id: UUID,
    role: MemberRole,
) -> WhiteboardElement:
    update_data = payload.model_dump(exclude={"vector_clock"}, exclude_unset=True, exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No element fields to update")

    await assert_can_mutate_element(db, element, role)
    before_state = element_state(element)
    for field, value in update_data.items():
        setattr(element, field, value)
    element.updated_at = datetime.now(UTC)
    await db.flush()
    await log_element_event(
        db,
        element=element,
        actor_id=actor_id,
        operation=EventOperation.UPDATE,
        before_state=before_state,
        after_state=element_state(element),
        vector_clock=payload.vector_clock,
    )
    await record_canvas_analytics(db, page_id=element.page_id, user_id=actor_id, transform=element.transform)
    return element


async def delete_element_state(
    db: AsyncSession,
    *,
    element: WhiteboardElement,
    actor_id: UUID,
    role: MemberRole,
) -> None:
    await assert_can_mutate_element(db, element, role, deleting=True)
    before_state = element_state(element)
    element.is_deleted = True
    element.updated_at = datetime.now(UTC)
    await db.flush()
    await log_element_event(
        db,
        element=element,
        actor_id=actor_id,
        operation=EventOperation.DELETE,
        before_state=before_state,
        after_state=element_state(element),
    )
    await record_canvas_analytics(db, page_id=element.page_id, user_id=actor_id, transform=element.transform)
