from enum import StrEnum


class MemberRole(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"


class ElementType(StrEnum):
    STROKE = "stroke"
    RECT = "rect"
    ELLIPSE = "ellipse"
    TEXT = "text"
    IMAGE = "image"
    MATH = "math"
    STICKY = "sticky"
    ARROW = "arrow"
    LINK = "link"


class EventOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    LOCK = "lock"
    UNLOCK = "unlock"
    RESTORE = "restore"


class AITriggerType(StrEnum):
    MATH = "math"
    IMAGE = "image"
    QUESTION = "question"
    TEXT_BLOCK = "text_block"
    CLOSED_SHAPE = "closed_shape"
    EXPLICIT = "explicit"


class WebhookEventType(StrEnum):
    """Validated at the API layer only — `webhooks.event_types` is a plain
    Postgres TEXT[], not a DB-level enum, so this has no matching CREATE TYPE."""

    ELEMENT_CREATE = "element:create"
    AI_RESPONSE = "ai:response"
    SESSION_END = "session:end"
    MEMBER_JOINED = "member:joined"
