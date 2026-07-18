from __future__ import annotations

from datetime import date
from uuid import UUID

from pydantic import BaseModel

from app.models.enums import AITriggerType


class HeatmapCell(BaseModel):
    region_x_bucket: int
    region_y_bucket: int
    total_edits: int
    unique_users: int


class ParticipationEntry(BaseModel):
    user_id: UUID
    display_name: str
    total_elements: int
    active_seconds: int


class AITriggerUsage(BaseModel):
    trigger_type: AITriggerType
    count: int
    avg_latency_ms: float | None


class AIUsageSummary(BaseModel):
    by_trigger_type: list[AITriggerUsage]
    total_interactions: int
    incorrect_feedback_percentage: float | None


class PageAnalytics(BaseModel):
    heatmap: list[HeatmapCell]
    participation: list[ParticipationEntry]
    most_active_day: date | None
    ai_usage: AIUsageSummary
