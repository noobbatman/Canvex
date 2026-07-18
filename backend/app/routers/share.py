from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_share_token, decode_share_token
from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.models.element import WhiteboardElement
from app.models.enums import MemberRole
from app.models.user import User
from app.schemas.share import ShareLinkCreate, ShareLinkRead, SharedPageView
from app.schemas.whiteboard import ElementRead, PageRead
from app.services.elements import assert_minimum_role, get_channel_membership_for_user, get_page_or_404

router = APIRouter(tags=["share"])


def decode_share_token_or_401(token: str) -> UUID:
    try:
        return decode_share_token(token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired share link") from None


@router.post("/pages/{page_id}/share", response_model=ShareLinkRead, status_code=status.HTTP_201_CREATED)
async def create_share_link(
    page_id: UUID,
    payload: ShareLinkCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ShareLinkRead:
    page = await get_page_or_404(db, page_id)
    membership = await get_channel_membership_for_user(db, page.channel_id, current_user.id)
    assert_minimum_role(membership, MemberRole.EDITOR)

    token, expires_at = create_share_token(page_id, payload.expires_in_hours)
    return ShareLinkRead(token=token, share_url=f"/view/{token}", expires_at=expires_at)


@router.get("/view/{token}", response_model=SharedPageView)
async def view_shared_page(token: str, db: AsyncSession = Depends(get_db)) -> SharedPageView:
    page_id = decode_share_token_or_401(token)
    page = await get_page_or_404(db, page_id)
    elements = (
        await db.scalars(
            select(WhiteboardElement)
            .where(WhiteboardElement.page_id == page_id, WhiteboardElement.is_deleted.is_(False))
            .order_by(WhiteboardElement.created_at.asc())
        )
    ).all()
    return SharedPageView(
        page=PageRead.model_validate(page),
        elements=[ElementRead.model_validate(element) for element in elements],
    )
