from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import AIFeedback, AIInteraction
from app.models.analytics import CanvasAnalytics
from app.models.audit import ElementEvent
from app.models.element import WhiteboardElement
from app.models.user import User
from app.schemas.analytics import AITriggerUsage, AIUsageSummary, HeatmapCell, PageAnalytics, ParticipationEntry

REGION_BUCKET_PX = 200


def region_bucket(value: float) -> int:
    """Map a canvas coordinate to its 200px grid bucket. Uses floor division
    (not truncation-toward-zero) so buckets stay a uniform 200px wide across
    negative canvas coordinates too."""
    return math.floor(value / REGION_BUCKET_PX)


async def record_canvas_analytics(
    db: AsyncSession,
    *,
    page_id: UUID,
    user_id: UUID | None,
    transform: dict[str, Any],
) -> None:
    """Upsert one edit_count increment for the canvas region a mutated element
    falls in, per plan 10.1. AI-authored elements have no attributable user
    (actor_id=None) and are skipped rather than recorded against no one."""
    if user_id is None:
        return

    x = float(transform.get("x") or 0)
    y = float(transform.get("y") or 0)

    stmt = pg_insert(CanvasAnalytics).values(
        page_id=page_id,
        user_id=user_id,
        session_date=datetime.now(UTC).date(),
        region_x_bucket=region_bucket(x),
        region_y_bucket=region_bucket(y),
        edit_count=1,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            CanvasAnalytics.page_id,
            CanvasAnalytics.user_id,
            CanvasAnalytics.session_date,
            CanvasAnalytics.region_x_bucket,
            CanvasAnalytics.region_y_bucket,
        ],
        set_={"edit_count": CanvasAnalytics.edit_count + 1},
    )
    await db.execute(stmt)


# Sentinel bucket for time-on-canvas bookkeeping. time_on_canvas_s is a
# per-user-per-page-per-day fact, not a per-region one, but it lives on the
# same region-bucketed row in this schema — so it's always written to one
# fixed bucket per user/page/day rather than split across whichever regions
# they happened to edit. Summing time_on_canvas_s across all of a user's rows
# for a page still gives the correct total, since every other bucket row's
# value stays at its default of 0.
TIME_TRACKING_BUCKET = (0, 0)


async def record_canvas_time(db: AsyncSession, *, page_id: UUID, user_id: UUID, seconds: int) -> None:
    """Accumulate WebSocket-connected seconds for a user on a page, per day.
    Called once per disconnect with that connection's duration."""
    if seconds <= 0:
        return

    region_x_bucket, region_y_bucket = TIME_TRACKING_BUCKET
    stmt = pg_insert(CanvasAnalytics).values(
        page_id=page_id,
        user_id=user_id,
        session_date=datetime.now(UTC).date(),
        region_x_bucket=region_x_bucket,
        region_y_bucket=region_y_bucket,
        time_on_canvas_s=seconds,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[
            CanvasAnalytics.page_id,
            CanvasAnalytics.user_id,
            CanvasAnalytics.session_date,
            CanvasAnalytics.region_x_bucket,
            CanvasAnalytics.region_y_bucket,
        ],
        set_={"time_on_canvas_s": CanvasAnalytics.time_on_canvas_s + seconds},
    )
    await db.execute(stmt)


async def _heatmap(db: AsyncSession, page_id: UUID) -> list[HeatmapCell]:
    # Matches the spec's reference heatmap query: current month, most-edited first.
    rows = await db.execute(
        select(
            CanvasAnalytics.region_x_bucket,
            CanvasAnalytics.region_y_bucket,
            func.sum(CanvasAnalytics.edit_count).label("total_edits"),
            func.count(func.distinct(CanvasAnalytics.user_id)).label("unique_users"),
        )
        .where(
            CanvasAnalytics.page_id == page_id,
            CanvasAnalytics.session_date >= func.date_trunc("month", func.now()),
        )
        .group_by(CanvasAnalytics.region_x_bucket, CanvasAnalytics.region_y_bucket)
        .order_by(func.sum(CanvasAnalytics.edit_count).desc())
    )
    return [
        HeatmapCell(
            region_x_bucket=region_x_bucket,
            region_y_bucket=region_y_bucket,
            total_edits=total_edits,
            unique_users=unique_users,
        )
        for region_x_bucket, region_y_bucket, total_edits, unique_users in rows.all()
    ]


async def _most_active_day(db: AsyncSession, page_id: UUID):
    return await db.scalar(
        select(CanvasAnalytics.session_date)
        .where(CanvasAnalytics.page_id == page_id)
        .group_by(CanvasAnalytics.session_date)
        .order_by(func.sum(CanvasAnalytics.edit_count).desc())
        .limit(1)
    )


async def _participation(db: AsyncSession, page_id: UUID) -> list[ParticipationEntry]:
    element_counts = dict(
        (
            await db.execute(
                select(WhiteboardElement.created_by, func.count())
                .where(
                    WhiteboardElement.page_id == page_id,
                    WhiteboardElement.is_deleted.is_(False),
                    WhiteboardElement.created_by.is_not(None),
                )
                .group_by(WhiteboardElement.created_by)
            )
        ).all()
    )

    # Primary source: actual WebSocket-connected seconds, tracked per
    # disconnect in ws.py via record_canvas_time. Summing across all of a
    # user's bucket rows for this page is correct regardless of which single
    # bucket the writes land in (see TIME_TRACKING_BUCKET), since every other
    # row's time_on_canvas_s stays at its default of 0.
    tracked_seconds = dict(
        (
            await db.execute(
                select(CanvasAnalytics.user_id, func.sum(CanvasAnalytics.time_on_canvas_s))
                .where(CanvasAnalytics.page_id == page_id)
                .group_by(CanvasAnalytics.user_id)
                .having(func.sum(CanvasAnalytics.time_on_canvas_s) > 0)
            )
        ).all()
    )

    # Fallback for users with no tracked WS session at all (e.g. they only
    # ever mutated elements via the REST fallback path): approximate from the
    # span between their first and last event on this page.
    activity_spans = dict(
        (
            await db.execute(
                select(
                    ElementEvent.actor_id,
                    func.extract("epoch", func.max(ElementEvent.occurred_at) - func.min(ElementEvent.occurred_at)),
                )
                .where(ElementEvent.page_id == page_id, ElementEvent.actor_id.is_not(None))
                .group_by(ElementEvent.actor_id)
            )
        ).all()
    )

    user_ids = set(element_counts) | set(tracked_seconds) | set(activity_spans)
    if not user_ids:
        return []

    users = (await db.scalars(select(User).where(User.id.in_(user_ids)))).all()

    entries = [
        ParticipationEntry(
            user_id=user.id,
            display_name=user.display_name,
            total_elements=element_counts.get(user.id, 0),
            active_seconds=int(tracked_seconds[user.id])
            if user.id in tracked_seconds
            else int(round(activity_spans.get(user.id) or 0)),
        )
        for user in users
    ]
    entries.sort(key=lambda entry: entry.total_elements, reverse=True)
    return entries


async def _ai_usage(db: AsyncSession, page_id: UUID) -> AIUsageSummary:
    trigger_rows = await db.execute(
        select(
            AIInteraction.trigger_type,
            func.count().label("count"),
            func.avg(AIInteraction.latency_ms).label("avg_latency_ms"),
        )
        .where(AIInteraction.page_id == page_id)
        .group_by(AIInteraction.trigger_type)
    )
    by_trigger_type = [
        AITriggerUsage(
            trigger_type=trigger_type,
            count=count,
            avg_latency_ms=float(avg_latency_ms) if avg_latency_ms is not None else None,
        )
        for trigger_type, count, avg_latency_ms in trigger_rows.all()
    ]
    total_interactions = sum(item.count for item in by_trigger_type)

    feedback_totals = (
        await db.execute(
            select(
                func.count().label("total_feedback"),
                func.count().filter(AIFeedback.is_correct.is_(False)).label("incorrect_feedback"),
            )
            .select_from(AIFeedback)
            .join(AIInteraction, AIInteraction.id == AIFeedback.interaction_id)
            .where(AIInteraction.page_id == page_id)
        )
    ).one()
    total_feedback, incorrect_feedback = feedback_totals
    incorrect_feedback_percentage = (
        round(incorrect_feedback / total_feedback * 100, 1) if total_feedback else None
    )

    return AIUsageSummary(
        by_trigger_type=by_trigger_type,
        total_interactions=total_interactions,
        incorrect_feedback_percentage=incorrect_feedback_percentage,
    )


async def get_page_analytics(db: AsyncSession, page_id: UUID) -> PageAnalytics:
    return PageAnalytics(
        heatmap=await _heatmap(db, page_id),
        participation=await _participation(db, page_id),
        most_active_day=await _most_active_day(db, page_id),
        ai_usage=await _ai_usage(db, page_id),
    )
