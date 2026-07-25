from __future__ import annotations

from typing import Literal
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.models.element import WhiteboardElement
from app.models.enums import MemberRole
from app.models.user import User
from app.services.elements import assert_minimum_role, get_channel_membership_for_user, get_page_or_404
from app.services.export import render_page_pdf, render_page_png

router = APIRouter(tags=["export"])


@router.get("/pages/{page_id}/export")
async def export_page(
    page_id: UUID,
    format: Literal["png", "pdf"] = Query(default="png"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    page = await get_page_or_404(db, page_id)
    membership = await get_channel_membership_for_user(db, page.channel_id, current_user.id)
    assert_minimum_role(membership, MemberRole.VIEWER)

    elements = list(
        (
            await db.scalars(
                select(WhiteboardElement)
                .where(WhiteboardElement.page_id == page_id, WhiteboardElement.is_deleted.is_(False))
                .order_by(WhiteboardElement.created_at.asc())
            )
        ).all()
    )

    # Pillow rendering is CPU-bound; run it off the event loop so a large page
    # export doesn't stall every concurrent request and WebSocket.
    if format == "pdf":
        return Response(
            content=await anyio.to_thread.run_sync(render_page_pdf, elements),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{page_id}.pdf"'},
        )

    return Response(
        content=await anyio.to_thread.run_sync(render_page_png, elements),
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{page_id}.png"'},
    )
