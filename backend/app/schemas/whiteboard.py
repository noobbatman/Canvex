from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.enums import ElementType

JsonObject = dict[str, Any]


def default_transform() -> JsonObject:
    return {"x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0}


def default_style() -> JsonObject:
    return {"stroke": "#000", "fill": "transparent", "strokeWidth": 2}


class PageCreate(BaseModel):
    title: str = Field(default="Untitled page", min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Page title cannot be blank")
        return normalized


class PageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    order_index: int | None = Field(default=None, ge=0)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip()
        if not normalized:
            raise ValueError("Page title cannot be blank")
        return normalized


class PageRead(BaseModel):
    id: UUID
    channel_id: UUID
    branch_of: UUID | None = None
    title: str
    order_index: int
    is_branch: bool
    is_deleted: bool
    created_by: UUID | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BranchCreate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip()
        if not normalized:
            raise ValueError("Branch title cannot be blank")
        return normalized


# Plan 12.1: reject oversized JSONB payloads before they reach the database.
MAX_ELEMENT_PAYLOAD_BYTES = 100 * 1024


def _assert_payload_size(*parts: JsonObject | None) -> None:
    total = sum(
        len(json.dumps(part, default=str).encode("utf-8")) for part in parts if part is not None
    )
    if total > MAX_ELEMENT_PAYLOAD_BYTES:
        raise ValueError(
            f"Element payload is {total} bytes; the maximum is {MAX_ELEMENT_PAYLOAD_BYTES} (100KB)"
        )


class ElementCreate(BaseModel):
    type: ElementType
    transform: JsonObject = Field(default_factory=default_transform)
    style: JsonObject = Field(default_factory=default_style)
    content: JsonObject = Field(default_factory=dict)
    vector_clock: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def limit_payload_size(self) -> "ElementCreate":
        _assert_payload_size(self.transform, self.style, self.content)
        return self


class ElementUpdate(BaseModel):
    transform: JsonObject | None = None
    style: JsonObject | None = None
    content: JsonObject | None = None
    vector_clock: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def limit_payload_size(self) -> "ElementUpdate":
        _assert_payload_size(self.transform, self.style, self.content)
        return self


class ElementRead(BaseModel):
    id: UUID
    page_id: UUID
    created_by: UUID | None = None
    type: ElementType
    transform: JsonObject
    style: JsonObject
    content: JsonObject
    locked_by: UUID | None = None
    is_deleted: bool
    last_event: UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BranchModifiedElement(BaseModel):
    parent: ElementRead
    branch: ElementRead


class BranchDiff(BaseModel):
    added: list[ElementRead]
    modified: list[BranchModifiedElement]
    deleted: list[ElementRead]


class BranchMergeRequest(BaseModel):
    strategy: Literal["ours", "theirs"] = "theirs"


class BranchMergeSummary(BaseModel):
    strategy: Literal["ours", "theirs"]
    added_count: int
    modified_count: int
    deleted_count: int
