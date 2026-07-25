from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func, text
from sqlalchemy.dialects.postgresql import ENUM, JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.enums import AITriggerType

ai_trigger_enum = ENUM(AITriggerType, name="ai_trigger", values_callable=lambda enum: [item.value for item in enum])


class AIInteraction(Base):
    __tablename__ = "ai_interactions"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    page_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("whiteboard_pages.id", ondelete="CASCADE"), nullable=False)
    trigger_element_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True))
    trigger_type: Mapped[AITriggerType] = mapped_column(ai_trigger_enum, nullable=False)
    canvas_snapshot_url: Mapped[str | None] = mapped_column(Text)
    prompt_sent: Mapped[str] = mapped_column(Text, nullable=False)
    response_json: Mapped[dict | None] = mapped_column(JSONB)
    response_element_id: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AIFeedback(Base):
    __tablename__ = "ai_feedback"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    interaction_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("ai_interactions.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    correction_text: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
