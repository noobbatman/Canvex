from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.models.enums import MemberRole
from app.models.user import User
from app.schemas.analytics import PageAnalytics
from app.services.analytics import get_page_analytics
from app.services.elements import assert_minimum_role, get_channel_membership_for_user, get_page_or_404

router = APIRouter(tags=["analytics"])


@router.get("/pages/{page_id}/analytics", response_model=PageAnalytics)
async def page_analytics(
    page_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PageAnalytics:
    page = await get_page_or_404(db, page_id)
    membership = await get_channel_membership_for_user(db, page.channel_id, current_user.id)
    assert_minimum_role(membership, MemberRole.VIEWER)
    return await get_page_analytics(db, page_id)
