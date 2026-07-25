from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import limiter, user_or_ip
from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.models.ai import AIFeedback, AIInteraction
from app.models.channel import ChannelMember
from app.models.element import WhiteboardElement
from app.models.enums import AITriggerType, MemberRole
from app.models.page import WhiteboardPage
from app.models.user import User
from app.schemas.ai import (
    AIAskRequest,
    AIAskResponse,
    AIFeedbackCreate,
    AIFeedbackRead,
    AIInteractionRead,
    AISearchResult,
    AISolveItem,
    AISolveRequest,
    AISolveResponse,
)
from app.schemas.whiteboard import ElementRead
from app.services.ai import answer_question_now, embed_text, solve_page_now
from app.services.elements import assert_minimum_role, get_channel_membership_for_user, get_page_or_404

router = APIRouter(tags=["ai"])


def interaction_read(interaction: AIInteraction) -> AIInteractionRead:
    return AIInteractionRead(
        id=interaction.id,
        page_id=interaction.page_id,
        trigger_element_id=interaction.trigger_element_id,
        trigger_type=interaction.trigger_type,
        canvas_snapshot_url=interaction.canvas_snapshot_url,
        prompt_sent=interaction.prompt_sent,
        response_json=interaction.response_json,
        response_element_id=interaction.response_element_id,
        input_tokens=interaction.input_tokens,
        output_tokens=interaction.output_tokens,
        latency_ms=interaction.latency_ms,
        status=interaction.status,
        error_message=interaction.error_message,
        created_at=interaction.created_at,
    )


async def assert_page_access(db: AsyncSession, page_id: UUID, user_id: UUID, minimum_role: MemberRole) -> WhiteboardPage:
    page = await get_page_or_404(db, page_id)
    membership = await get_channel_membership_for_user(db, page.channel_id, user_id)
    assert_minimum_role(membership, minimum_role)
    return page


@router.get("/pages/{page_id}/ai-log", response_model=list[AIInteractionRead])
async def list_page_ai_log(
    page_id: UUID,
    trigger_type: AITriggerType | None = None,
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AIInteractionRead]:
    await assert_page_access(db, page_id, current_user.id, MemberRole.VIEWER)
    conditions = [AIInteraction.page_id == page_id]
    if trigger_type is not None:
        conditions.append(AIInteraction.trigger_type == trigger_type)
    if from_ is not None:
        conditions.append(AIInteraction.created_at >= from_)
    if to is not None:
        conditions.append(AIInteraction.created_at <= to)

    interactions = await db.scalars(
        select(AIInteraction)
        .where(*conditions)
        .order_by(AIInteraction.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [interaction_read(interaction) for interaction in interactions.all()]


@router.post("/ai/{interaction_id}/feedback", response_model=AIFeedbackRead, status_code=status.HTTP_201_CREATED)
async def submit_ai_feedback(
    interaction_id: UUID,
    payload: AIFeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AIFeedbackRead:
    interaction = await db.get(AIInteraction, interaction_id)
    if interaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI interaction not found")
    await assert_page_access(db, interaction.page_id, current_user.id, MemberRole.VIEWER)

    feedback = AIFeedback(
        interaction_id=interaction.id,
        user_id=current_user.id,
        is_correct=payload.is_correct,
        correction_text=payload.correction_text,
    )
    db.add(feedback)
    await db.commit()
    await db.refresh(feedback)
    return AIFeedbackRead(
        id=feedback.id,
        interaction_id=feedback.interaction_id,
        user_id=feedback.user_id,
        is_correct=feedback.is_correct,
        correction_text=feedback.correction_text,
        created_at=feedback.created_at,
    )


@router.post("/pages/{page_id}/ask", response_model=AIAskResponse)
@limiter.limit("20/minute", key_func=user_or_ip)  # plan 12.2: Gemini cost abuse
async def ask_canvex(
    request: Request,
    page_id: UUID,
    payload: AIAskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AIAskResponse:
    """Answer a question synchronously and return it in the HTTP response, so the
    asker sees it instantly with no AI worker running. The reply is not placed on
    the canvas — the frontend shows it and lets the user choose to add it."""
    page = await assert_page_access(db, page_id, current_user.id, MemberRole.EDITOR)
    interaction, source, answer = await answer_question_now(
        db,
        page=page,
        question=payload.question,
        snapshot_b64=payload.snapshot_b64,
    )
    return AIAskResponse(
        answer=answer,
        source=source,
        interaction=interaction_read(interaction),
        latency_ms=interaction.latency_ms or 0,
    )


@router.post("/pages/{page_id}/solve", response_model=AISolveResponse)
@limiter.limit("15/minute", key_func=user_or_ip)  # plan 12.2: Gemini cost abuse
async def solve_page(
    request: Request,
    page_id: UUID,
    payload: AISolveRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AISolveResponse:
    """Scan the whole page image and return an answer for every problem that
    needs one, each with a normalised position so the frontend can drop the
    answer next to it. Runs synchronously; no AI worker needed."""
    page = await assert_page_access(db, page_id, current_user.id, MemberRole.EDITOR)
    source, items, latency_ms = await solve_page_now(db, page=page, snapshot_b64=payload.snapshot_b64)
    return AISolveResponse(
        source=source,
        answers=[AISolveItem(**item) for item in items],
        latency_ms=latency_ms,
    )


@router.get("/search", response_model=list[AISearchResult])
@limiter.limit("20/minute", key_func=user_or_ip)  # plan 12.2: Gemini cost abuse
async def semantic_search(
    request: Request,
    q: str = Query(min_length=1, max_length=500),
    channel_id: UUID | None = None,
    limit: int = Query(default=10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AISearchResult]:
    query_embedding = await embed_text(q)
    distance = WhiteboardElement.embedding.cosine_distance(query_embedding).label("distance")
    conditions = [
        WhiteboardElement.is_deleted.is_(False),
        WhiteboardElement.embedding.is_not(None),
        WhiteboardPage.is_deleted.is_(False),
        ChannelMember.user_id == current_user.id,
    ]
    if channel_id is not None:
        conditions.append(WhiteboardPage.channel_id == channel_id)

    rows = await db.execute(
        select(WhiteboardElement, distance)
        .join(WhiteboardPage, WhiteboardPage.id == WhiteboardElement.page_id)
        .join(ChannelMember, ChannelMember.channel_id == WhiteboardPage.channel_id)
        .where(*conditions)
        .order_by(distance.asc())
        .limit(limit)
    )
    return [
        AISearchResult(
            element=ElementRead.model_validate(element),
            similarity=max(0.0, 1.0 - float(raw_distance or 0.0)),
        )
        for element, raw_distance in rows.all()
    ]
