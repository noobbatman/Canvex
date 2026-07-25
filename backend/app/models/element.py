from datetime import datetime
from uuid import UUID

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, DateTime, ForeignKey, PrimaryKeyConstraint, func, text
from sqlalchemy.dialects.postgresql import ENUM, JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.channel import member_role_enum
from app.models.enums import ElementType, MemberRole

element_type_enum = ENUM(ElementType, name="element_type", values_callable=lambda enum: [item.value for item in enum])


class WhiteboardElement(Base):
    __tablename__ = "whiteboard_elements"

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    page_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("whiteboard_pages.id", ondelete="CASCADE"), nullable=False)
    created_by: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"))
    type: Mapped[ElementType] = mapped_column(element_type_enum, nullable=False)
    transform: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("jsonb_build_object('x', 0, 'y', 0, 'scaleX', 1, 'scaleY', 1, 'rotation', 0)"),
    )
    style: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("jsonb_build_object('stroke', '#000', 'fill', 'transparent', 'strokeWidth', 2)"),
    )
    content: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    locked_by: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"))
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768))
    last_event: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ElementPermission(Base):
    __tablename__ = "element_permissions"
    __table_args__ = (PrimaryKeyConstraint("element_id", "role"),)

    element_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    role: Mapped[MemberRole] = mapped_column(member_role_enum, nullable=False)
    can_read: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    can_edit: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    can_delete: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
