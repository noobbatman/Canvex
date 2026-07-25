from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.models.enums import AITriggerType
from app.schemas.whiteboard import ElementRead


class AIInteractionRead(BaseModel):
    id: UUID
    page_id: UUID
    trigger_element_id: UUID | None
    trigger_type: AITriggerType
    canvas_snapshot_url: str | None
    prompt_sent: str
    response_json: dict[str, Any] | None
    response_element_id: UUID | None
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int | None
    status: str
    error_message: str | None
    created_at: datetime


class AIFeedbackCreate(BaseModel):
    is_correct: bool
    correction_text: str | None = Field(default=None, max_length=2000)

    @field_validator("correction_text")
    @classmethod
    def normalize_correction(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip()
        return normalized or None


class AIFeedbackRead(BaseModel):
    id: UUID
    interaction_id: UUID
    user_id: UUID
    is_correct: bool
    correction_text: str | None
    created_at: datetime


class AISearchResult(BaseModel):
    element: ElementRead
    similarity: float


# ~8M chars of base64 ≈ 6MB image — generous for a page snapshot, but caps a
# resource-exhaustion attack that streams an enormous payload to be decoded+written.
MAX_SNAPSHOT_CHARS = 8_000_000


class AIAskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    # Optional base64 PNG of the canvas so Gemini can "see" it (vision model).
    snapshot_b64: str | None = Field(default=None, max_length=MAX_SNAPSHOT_CHARS)

    @field_validator("question")
    @classmethod
    def _strip_question(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Question cannot be blank")
        return normalized


class AIAskResponse(BaseModel):
    answer: str
    source: str  # "gemini" | "local" | "local-fallback"
    interaction: AIInteractionRead
    latency_ms: int


class AISolveRequest(BaseModel):
    # Base64 PNG of the page for the vision model to scan.
    snapshot_b64: str | None = Field(default=None, max_length=MAX_SNAPSHOT_CHARS)


class AISolveItem(BaseModel):
    problem: str
    answer: str
    # Normalised 0–1 position of the problem in the image (None → stack it).
    x: float | None = None
    y: float | None = None


class AISolveResponse(BaseModel):
    source: str  # "gemini" | "local" | "local-fallback"
    answers: list[AISolveItem]
    latency_ms: int
