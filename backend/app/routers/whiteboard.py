from __future__ import annotations

from collections.abc import Callable, Coroutine
from contextlib import suppress
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.middleware.rbac import require_channel_role
from app.models.channel import ChannelMember
from app.models.element import WhiteboardElement
from app.models.enums import ElementType, MemberRole
from app.models.page import WhiteboardPage
from app.models.user import User
from app.schemas.whiteboard import (
    BranchCreate,
    BranchDiff,
    BranchMergeRequest,
    BranchMergeSummary,
    BranchModifiedElement,
    ElementCreate,
    ElementRead,
    ElementUpdate,
    PageCreate,
    PageRead,
    PageUpdate,
)
from app.services.branching import compute_branch_diff, create_page_branch, merge_branch_into_parent, strip_branch_metadata
from app.services.ai import enqueue_text_embedding
from app.services.element_events import element_state
from app.services.elements import (
    assert_minimum_role,
    create_element_for_page,
    delete_element_state,
    get_channel_membership_for_user,
    get_element_or_404,
    get_page_or_404,
    update_element_state,
)
from app.services.redis import assert_no_foreign_lock, get_redis
from app.services.webhooks import dispatch_webhook_event_for_page

router = APIRouter(tags=["whiteboard"])

PageAccess = tuple[WhiteboardPage, ChannelMember]
ElementAccess = tuple[WhiteboardElement, WhiteboardPage, ChannelMember]


def element_read_without_branch_metadata(element: WhiteboardElement) -> ElementRead:
    item = ElementRead.model_validate(element)
    return item.model_copy(update={"content": strip_branch_metadata(item.content)})


def require_page_role(minimum_role: MemberRole) -> Callable[..., Coroutine[Any, Any, PageAccess]]:
    async def dependency(
        page_id: UUID,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> PageAccess:
        page = await get_page_or_404(db, page_id)
        membership = await get_channel_membership_for_user(db, page.channel_id, current_user.id)
        assert_minimum_role(membership, minimum_role)
        return page, membership

    return dependency


def require_element_role(minimum_role: MemberRole) -> Callable[..., Coroutine[Any, Any, ElementAccess]]:
    async def dependency(
        element_id: UUID,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> ElementAccess:
        element = await get_element_or_404(db, element_id)
        page = await get_page_or_404(db, element.page_id)
        membership = await get_channel_membership_for_user(db, page.channel_id, current_user.id)
        assert_minimum_role(membership, minimum_role)
        return element, page, membership

    return dependency


@router.post("/channels/{channel_id}/pages", response_model=PageRead, status_code=status.HTTP_201_CREATED)
async def create_page(
    channel_id: UUID,
    payload: PageCreate,
    _: ChannelMember = Depends(require_channel_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WhiteboardPage:
    max_order = await db.scalar(
        select(func.coalesce(func.max(WhiteboardPage.order_index), -1)).where(
            WhiteboardPage.channel_id == channel_id,
            WhiteboardPage.is_deleted.is_(False),
        )
    )
    page = WhiteboardPage(
        channel_id=channel_id,
        title=payload.title,
        order_index=max_order + 1,
        created_by=current_user.id,
    )
    db.add(page)
    await db.commit()
    await db.refresh(page)
    return page


@router.get("/channels/{channel_id}/pages", response_model=list[PageRead])
async def list_pages(
    channel_id: UUID,
    _: ChannelMember = Depends(require_channel_role(MemberRole.VIEWER)),
    db: AsyncSession = Depends(get_db),
) -> list[WhiteboardPage]:
    pages = await db.scalars(
        select(WhiteboardPage)
        .where(
            WhiteboardPage.channel_id == channel_id,
            WhiteboardPage.is_deleted.is_(False),
        )
        .order_by(WhiteboardPage.order_index.asc(), WhiteboardPage.created_at.asc())
    )
    return list(pages.all())


@router.post("/pages/{page_id}/branch", response_model=PageRead, status_code=status.HTTP_201_CREATED)
async def branch_page(
    payload: BranchCreate | None = None,
    access: PageAccess = Depends(require_page_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WhiteboardPage:
    page, _membership = access
    branch = await create_page_branch(
        db,
        page=page,
        actor_id=current_user.id,
        title=payload.title if payload else None,
    )
    await db.commit()
    await db.refresh(branch)
    return branch


@router.get("/pages/{page_id}/diff", response_model=BranchDiff)
async def diff_page_branch(
    access: PageAccess = Depends(require_page_role(MemberRole.VIEWER)),
    db: AsyncSession = Depends(get_db),
) -> BranchDiff:
    branch, _membership = access
    diff = await compute_branch_diff(db, branch)
    return BranchDiff(
        added=[element_read_without_branch_metadata(element) for element in diff.added],
        modified=[
            BranchModifiedElement(
                parent=element_read_without_branch_metadata(parent),
                branch=element_read_without_branch_metadata(branch_element),
            )
            for parent, branch_element in diff.modified
        ],
        deleted=[element_read_without_branch_metadata(element) for element in diff.deleted],
    )


@router.post("/pages/{page_id}/merge", response_model=BranchMergeSummary)
async def merge_page_branch(
    payload: BranchMergeRequest,
    access: PageAccess = Depends(require_page_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BranchMergeSummary:
    branch, _membership = access
    summary = await merge_branch_into_parent(
        db,
        branch=branch,
        actor_id=current_user.id,
        strategy=payload.strategy,
    )
    await db.commit()
    return summary


@router.patch("/pages/{page_id}", response_model=PageRead)
async def update_page(
    payload: PageUpdate,
    access: PageAccess = Depends(require_page_role(MemberRole.EDITOR)),
    db: AsyncSession = Depends(get_db),
) -> WhiteboardPage:
    page, _membership = access
    if payload.title is not None:
        page.title = payload.title

    if payload.order_index is not None and payload.order_index != page.order_index:
        old_index = page.order_index
        max_order = await db.scalar(
            select(func.coalesce(func.max(WhiteboardPage.order_index), 0)).where(
                WhiteboardPage.channel_id == page.channel_id,
                WhiteboardPage.is_deleted.is_(False),
            )
        )
        new_index = max(0, min(payload.order_index, max_order))
        if new_index < old_index:
            await db.execute(
                update(WhiteboardPage)
                .where(
                    WhiteboardPage.channel_id == page.channel_id,
                    WhiteboardPage.id != page.id,
                    WhiteboardPage.is_deleted.is_(False),
                    WhiteboardPage.order_index >= new_index,
                    WhiteboardPage.order_index < old_index,
                )
                .values(order_index=WhiteboardPage.order_index + 1)
            )
        elif new_index > old_index:
            await db.execute(
                update(WhiteboardPage)
                .where(
                    WhiteboardPage.channel_id == page.channel_id,
                    WhiteboardPage.id != page.id,
                    WhiteboardPage.is_deleted.is_(False),
                    WhiteboardPage.order_index > old_index,
                    WhiteboardPage.order_index <= new_index,
                )
                .values(order_index=WhiteboardPage.order_index - 1)
            )
        page.order_index = new_index

    await db.commit()
    await db.refresh(page)
    return page


@router.delete("/pages/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_page(
    access: PageAccess = Depends(require_page_role(MemberRole.EDITOR)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    page, _membership = access
    page.is_deleted = True
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/pages/{page_id}/elements", response_model=list[ElementRead])
async def list_elements(
    page_id: UUID,
    element_type: Annotated[ElementType | None, Query(alias="type")] = None,
    search: str | None = Query(default=None, min_length=1, max_length=200),
    _: PageAccess = Depends(require_page_role(MemberRole.VIEWER)),
    db: AsyncSession = Depends(get_db),
) -> list[WhiteboardElement]:
    conditions = [
        WhiteboardElement.page_id == page_id,
        WhiteboardElement.is_deleted.is_(False),
    ]
    if element_type is not None:
        conditions.append(WhiteboardElement.type == element_type)
    if search is not None:
        conditions.append(WhiteboardElement.content["text"].astext.ilike(f"%{search}%"))

    elements = await db.scalars(
        select(WhiteboardElement)
        .where(*conditions)
        .order_by(WhiteboardElement.created_at.asc())
    )
    return list(elements.all())


@router.post("/pages/{page_id}/elements", response_model=ElementRead, status_code=status.HTTP_201_CREATED)
async def create_element(
    page_id: UUID,
    payload: ElementCreate,
    access: PageAccess = Depends(require_page_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WhiteboardElement:
    _page, _membership = access
    element = await create_element_for_page(
        db,
        page_id=page_id,
        payload=payload,
        actor_id=current_user.id,
    )
    await db.commit()
    await db.refresh(element)
    if element.type in {ElementType.TEXT, ElementType.MATH, ElementType.STICKY}:
        with suppress(Exception):
            await enqueue_text_embedding(element_id=element.id)
    with suppress(Exception):
        await dispatch_webhook_event_for_page(
            db, page_id=page_id, event_type="element:create", payload=element_state(element)
        )
    return element


@router.patch("/elements/{element_id}", response_model=ElementRead)
async def update_element(
    payload: ElementUpdate,
    access: ElementAccess = Depends(require_element_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WhiteboardElement:
    element, _page, membership = access
    # The REST routes are the fallback mutation path (initial load, offline
    # sync); they must respect the same Redis element locks as the WS path.
    await assert_no_foreign_lock(get_redis(), element.id, current_user.id)
    await update_element_state(
        db,
        element=element,
        payload=payload,
        actor_id=current_user.id,
        role=membership.role,
    )
    await db.commit()
    await db.refresh(element)
    if element.type in {ElementType.TEXT, ElementType.MATH, ElementType.STICKY}:
        with suppress(Exception):
            await enqueue_text_embedding(element_id=element.id)
    return element


@router.delete("/elements/{element_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_element(
    access: ElementAccess = Depends(require_element_role(MemberRole.EDITOR)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    element, _page, membership = access
    await assert_no_foreign_lock(get_redis(), element.id, current_user.id)
    await delete_element_state(
        db,
        element=element,
        actor_id=current_user.id,
        role=membership.role,
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
