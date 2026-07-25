from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.element import WhiteboardElement
from app.models.enums import EventOperation
from app.models.page import WhiteboardPage
from app.schemas.whiteboard import BranchMergeSummary
from app.services.element_events import element_state, log_element_event

ORIGIN_ID_KEY = "_origin_id"
MergeStrategy = Literal["ours", "theirs"]


@dataclass(frozen=True)
class BranchDiffResult:
    added: list[WhiteboardElement]
    modified: list[tuple[WhiteboardElement, WhiteboardElement]]
    deleted: list[WhiteboardElement]


def strip_branch_metadata(content: dict) -> dict:
    clean_content = deepcopy(content)
    clean_content.pop(ORIGIN_ID_KEY, None)
    return clean_content


def content_with_origin(element: WhiteboardElement) -> dict:
    content = strip_branch_metadata(element.content)
    content[ORIGIN_ID_KEY] = str(element.id)
    return content


def origin_id_for(element: WhiteboardElement) -> UUID | None:
    origin_id = element.content.get(ORIGIN_ID_KEY)
    if not origin_id:
        return None
    try:
        return UUID(str(origin_id))
    except ValueError:
        return None


def branch_equals_parent(branch_element: WhiteboardElement, parent_element: WhiteboardElement) -> bool:
    return (
        branch_element.type == parent_element.type
        and branch_element.transform == parent_element.transform
        and branch_element.style == parent_element.style
        and strip_branch_metadata(branch_element.content) == strip_branch_metadata(parent_element.content)
    )


async def list_live_elements(db: AsyncSession, page_id: UUID) -> list[WhiteboardElement]:
    elements = await db.scalars(
        select(WhiteboardElement)
        .where(
            WhiteboardElement.page_id == page_id,
            WhiteboardElement.is_deleted.is_(False),
        )
        .order_by(WhiteboardElement.created_at.asc())
    )
    return list(elements.all())


async def create_page_branch(
    db: AsyncSession,
    *,
    page: WhiteboardPage,
    actor_id: UUID,
    title: str | None,
) -> WhiteboardPage:
    if page.is_branch:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot branch from another branch")

    max_order = await db.scalar(
        select(func.coalesce(func.max(WhiteboardPage.order_index), -1)).where(
            WhiteboardPage.channel_id == page.channel_id,
            WhiteboardPage.is_deleted.is_(False),
        )
    )
    branch = WhiteboardPage(
        channel_id=page.channel_id,
        branch_of=page.id,
        title=title or f"{page.title} branch",
        order_index=(max_order if max_order is not None else -1) + 1,
        is_branch=True,
        created_by=actor_id,
    )
    db.add(branch)
    await db.flush()

    parent_elements = await list_live_elements(db, page.id)
    branch_elements = [
        WhiteboardElement(
            page_id=branch.id,
            created_by=actor_id,
            type=element.type,
            transform=deepcopy(element.transform),
            style=deepcopy(element.style),
            content=content_with_origin(element),
        )
        for element in parent_elements
    ]
    db.add_all(branch_elements)
    await db.flush()

    for element in branch_elements:
        await log_element_event(
            db,
            element=element,
            actor_id=actor_id,
            operation=EventOperation.CREATE,
            before_state=None,
            after_state=element_state(element),
        )

    return branch


async def compute_branch_diff(db: AsyncSession, branch: WhiteboardPage) -> BranchDiffResult:
    if not branch.is_branch or branch.branch_of is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Page is not a branch")

    parent_elements = await list_live_elements(db, branch.branch_of)
    branch_elements = await list_live_elements(db, branch.id)
    parents_by_id = {element.id: element for element in parent_elements}
    matched_parent_ids: set[UUID] = set()
    added: list[WhiteboardElement] = []
    modified: list[tuple[WhiteboardElement, WhiteboardElement]] = []

    for branch_element in branch_elements:
        origin_id = origin_id_for(branch_element)
        parent_element = parents_by_id.get(origin_id) if origin_id is not None else None
        if parent_element is None:
            added.append(branch_element)
            continue

        matched_parent_ids.add(parent_element.id)
        if not branch_equals_parent(branch_element, parent_element):
            modified.append((parent_element, branch_element))

    deleted = [
        element
        for element in parent_elements
        if element.id not in matched_parent_ids and element.created_at <= branch.created_at
    ]
    return BranchDiffResult(added=added, modified=modified, deleted=deleted)


async def copy_branch_element_to_parent(
    db: AsyncSession,
    *,
    branch_element: WhiteboardElement,
    parent_page_id: UUID,
    actor_id: UUID,
) -> WhiteboardElement:
    parent_element = WhiteboardElement(
        page_id=parent_page_id,
        created_by=actor_id,
        type=branch_element.type,
        transform=deepcopy(branch_element.transform),
        style=deepcopy(branch_element.style),
        content=strip_branch_metadata(branch_element.content),
    )
    db.add(parent_element)
    await db.flush()
    await log_element_event(
        db,
        element=parent_element,
        actor_id=actor_id,
        operation=EventOperation.CREATE,
        before_state=None,
        after_state=element_state(parent_element),
    )
    return parent_element


async def apply_branch_element_to_parent(
    db: AsyncSession,
    *,
    parent_element: WhiteboardElement,
    branch_element: WhiteboardElement,
    actor_id: UUID,
) -> None:
    before_state = element_state(parent_element)
    parent_element.type = branch_element.type
    parent_element.transform = deepcopy(branch_element.transform)
    parent_element.style = deepcopy(branch_element.style)
    parent_element.content = strip_branch_metadata(branch_element.content)
    parent_element.locked_by = None
    parent_element.is_deleted = False
    parent_element.updated_at = datetime.now(UTC)
    await db.flush()
    await log_element_event(
        db,
        element=parent_element,
        actor_id=actor_id,
        operation=EventOperation.UPDATE,
        before_state=before_state,
        after_state=element_state(parent_element),
    )


async def delete_parent_element_for_merge(
    db: AsyncSession,
    *,
    parent_element: WhiteboardElement,
    actor_id: UUID,
) -> None:
    before_state = element_state(parent_element)
    parent_element.is_deleted = True
    parent_element.updated_at = datetime.now(UTC)
    await db.flush()
    await log_element_event(
        db,
        element=parent_element,
        actor_id=actor_id,
        operation=EventOperation.DELETE,
        before_state=before_state,
        after_state=element_state(parent_element),
    )


async def merge_branch_into_parent(
    db: AsyncSession,
    *,
    branch: WhiteboardPage,
    actor_id: UUID,
    strategy: MergeStrategy,
) -> BranchMergeSummary:
    diff = await compute_branch_diff(db, branch)
    parent_page_id = branch.branch_of
    if parent_page_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Page is not a branch")

    for branch_element in diff.added:
        await copy_branch_element_to_parent(
            db,
            branch_element=branch_element,
            parent_page_id=parent_page_id,
            actor_id=actor_id,
        )

    modified_count = 0
    if strategy == "theirs":
        for parent_element, branch_element in diff.modified:
            await apply_branch_element_to_parent(
                db,
                parent_element=parent_element,
                branch_element=branch_element,
                actor_id=actor_id,
            )
            modified_count += 1

    # Deletions are unconditional: an element removed in the branch is removed
    # from the parent regardless of merge strategy (only "modified" elements
    # are subject to the ours/theirs choice).
    deleted_count = 0
    for parent_element in diff.deleted:
        await delete_parent_element_for_merge(db, parent_element=parent_element, actor_id=actor_id)
        deleted_count += 1

    branch.is_deleted = True

    return BranchMergeSummary(
        strategy=strategy,
        added_count=len(diff.added),
        modified_count=modified_count,
        deleted_count=deleted_count,
    )
