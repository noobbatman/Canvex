from __future__ import annotations

import secrets
from contextlib import suppress
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.middleware.rbac import ROLE_RANK, get_channel_membership, require_channel_role
from app.models.channel import Channel, ChannelInvite, ChannelMember
from app.models.enums import MemberRole
from app.models.page import WhiteboardPage
from app.models.user import User
from app.schemas.channel import (
    ChannelCreate,
    ChannelDetail,
    ChannelListItem,
    ChannelRead,
    ChannelUpdate,
    InviteCreate,
    InviteRead,
    MemberRead,
    MemberRoleUpdate,
    PageSummary,
)
from app.services.webhooks import dispatch_webhook_event_for_channel

router = APIRouter(tags=["channels"])


def invite_url(code: str) -> str:
    return f"{settings.api_base_url.rstrip('/')}/invites/{code}"


def channel_list_item(channel: Channel, role: MemberRole) -> ChannelListItem:
    return ChannelListItem(**ChannelRead.model_validate(channel).model_dump(), role=role)


async def get_channel_or_404(db: AsyncSession, channel_id: UUID) -> Channel:
    channel = await db.get(Channel, channel_id)
    if channel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel not found")
    return channel


async def get_member_or_404(db: AsyncSession, channel_id: UUID, user_id: UUID) -> ChannelMember:
    member = await db.scalar(
        select(ChannelMember).where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
        )
    )
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Channel member not found")
    return member


def assert_can_change_member_role(
    requester: ChannelMember,
    target: ChannelMember,
    new_role: MemberRole,
    current_user: User,
) -> None:
    if target.role == MemberRole.OWNER and target.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can transfer ownership")

    if target.role == MemberRole.OWNER and new_role != MemberRole.OWNER:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transfer ownership by assigning owner to another member")

    if new_role == MemberRole.OWNER and requester.role != MemberRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can transfer ownership")

    if new_role == MemberRole.ADMIN and requester.role != MemberRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can promote admins")

    if target.role == MemberRole.ADMIN and requester.role != MemberRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can change admins")

    if ROLE_RANK[requester.role] <= ROLE_RANK[target.role] and requester.user_id != target.user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot change a peer or higher role")


@router.post("/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED)
async def create_channel(
    payload: ChannelCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Channel:
    channel = Channel(
        name=payload.name,
        description=payload.description,
        owner_id=current_user.id,
        is_private=payload.is_private,
    )
    db.add(channel)
    await db.flush()
    db.add(ChannelMember(channel_id=channel.id, user_id=current_user.id, role=MemberRole.OWNER))
    await db.commit()
    await db.refresh(channel)
    return channel


@router.get("/channels", response_model=list[ChannelListItem])
async def list_channels(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ChannelListItem]:
    rows = await db.execute(
        select(Channel, ChannelMember.role)
        .join(ChannelMember, ChannelMember.channel_id == Channel.id)
        .where(ChannelMember.user_id == current_user.id)
        .order_by(Channel.created_at.desc())
    )
    return [channel_list_item(channel, role) for channel, role in rows.all()]


@router.get("/channels/{channel_id}", response_model=ChannelDetail)
async def get_channel(
    channel_id: UUID,
    membership: ChannelMember = Depends(require_channel_role(MemberRole.VIEWER)),
    db: AsyncSession = Depends(get_db),
) -> ChannelDetail:
    channel = await get_channel_or_404(db, channel_id)
    member_rows = await db.execute(
        select(ChannelMember, User)
        .join(User, User.id == ChannelMember.user_id)
        .where(ChannelMember.channel_id == channel_id)
        .order_by(ChannelMember.joined_at.asc())
    )
    page_rows = await db.scalars(
        select(WhiteboardPage)
        .where(WhiteboardPage.channel_id == channel_id, WhiteboardPage.is_deleted.is_(False))
        .order_by(WhiteboardPage.order_index.asc(), WhiteboardPage.created_at.asc())
    )

    return ChannelDetail(
        **ChannelRead.model_validate(channel).model_dump(),
        role=membership.role,
        members=[
            MemberRead(
                user_id=user.id,
                email=user.email,
                display_name=user.display_name,
                avatar_url=user.avatar_url,
                role=member.role,
                joined_at=member.joined_at,
            )
            for member, user in member_rows.all()
        ],
        pages=[
            PageSummary(
                id=page.id,
                title=page.title,
                order_index=page.order_index,
                is_branch=page.is_branch,
                branch_of=page.branch_of,
                created_at=page.created_at,
            )
            for page in page_rows.all()
        ],
    )


@router.patch("/channels/{channel_id}", response_model=ChannelRead)
async def update_channel(
    channel_id: UUID,
    payload: ChannelUpdate,
    _: ChannelMember = Depends(require_channel_role(MemberRole.ADMIN)),
    db: AsyncSession = Depends(get_db),
) -> Channel:
    channel = await get_channel_or_404(db, channel_id)
    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(channel, field, value)
    await db.commit()
    await db.refresh(channel)
    return channel


@router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: UUID,
    _: ChannelMember = Depends(require_channel_role(MemberRole.OWNER)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    channel = await get_channel_or_404(db, channel_id)
    await db.delete(channel)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/channels/{channel_id}/members/{user_id}", response_model=MemberRead)
async def update_member_role(
    channel_id: UUID,
    user_id: UUID,
    payload: MemberRoleUpdate,
    requester: ChannelMember = Depends(require_channel_role(MemberRole.ADMIN)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemberRead:
    channel = await get_channel_or_404(db, channel_id)
    target = await get_member_or_404(db, channel_id, user_id)
    target_user = await db.get(User, user_id)
    if target_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    assert_can_change_member_role(requester, target, payload.role, current_user)

    if payload.role == MemberRole.OWNER and target.user_id != channel.owner_id:
        old_owner = await get_member_or_404(db, channel_id, channel.owner_id)
        old_owner.role = MemberRole.ADMIN
        target.role = MemberRole.OWNER
        channel.owner_id = target.user_id
    else:
        target.role = payload.role

    await db.commit()
    return MemberRead(
        user_id=target_user.id,
        email=target_user.email,
        display_name=target_user.display_name,
        avatar_url=target_user.avatar_url,
        role=target.role,
        joined_at=target.joined_at,
    )


@router.delete("/channels/{channel_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    channel_id: UUID,
    user_id: UUID,
    requester: ChannelMember = Depends(get_channel_membership),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    target = await get_member_or_404(db, channel_id, user_id)
    if target.role == MemberRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot remove the channel owner")

    is_self_removal = target.user_id == current_user.id
    if not is_self_removal:
        if ROLE_RANK[requester.role] < ROLE_RANK[MemberRole.ADMIN]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
        if requester.role == MemberRole.ADMIN and ROLE_RANK[target.role] >= ROLE_RANK[MemberRole.ADMIN]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins can only remove editors and viewers")

    await db.execute(
        delete(ChannelMember).where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/channels/{channel_id}/invites", response_model=InviteRead, status_code=status.HTTP_201_CREATED)
async def create_invite(
    channel_id: UUID,
    payload: InviteCreate,
    _: ChannelMember = Depends(require_channel_role(MemberRole.ADMIN)),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InviteRead:
    await get_channel_or_404(db, channel_id)
    invite = ChannelInvite(
        channel_id=channel_id,
        created_by=current_user.id,
        code=secrets.token_hex(8),
        role_on_join=payload.role_on_join,
        max_uses=payload.max_uses,
        expires_at=payload.expires_at,
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)
    return InviteRead(
        id=invite.id,
        channel_id=invite.channel_id,
        code=invite.code,
        invite_url=invite_url(invite.code),
        role_on_join=invite.role_on_join,
        max_uses=invite.max_uses,
        uses_count=invite.uses_count,
        expires_at=invite.expires_at,
        created_at=invite.created_at,
    )


@router.post("/invites/{code}/accept", response_model=ChannelListItem)
async def accept_invite(
    code: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChannelListItem:
    invite = await db.scalar(
        select(ChannelInvite)
        .where(func.lower(ChannelInvite.code) == code.lower())
        .with_for_update()
    )
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")

    now = datetime.now(UTC)
    if invite.expires_at is not None and invite.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invite has expired")

    if invite.max_uses is not None and invite.uses_count >= invite.max_uses:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invite has reached its usage limit")

    existing_member = await db.scalar(
        select(ChannelMember).where(
            ChannelMember.channel_id == invite.channel_id,
            ChannelMember.user_id == current_user.id,
        )
    )
    if existing_member is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You are already a member of this channel")

    channel = await get_channel_or_404(db, invite.channel_id)
    db.add(ChannelMember(channel_id=invite.channel_id, user_id=current_user.id, role=invite.role_on_join))
    invite.uses_count += 1

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You are already a member of this channel") from None

    with suppress(Exception):
        await dispatch_webhook_event_for_channel(
            db,
            channel_id=invite.channel_id,
            event_type="member:joined",
            payload={
                "channel_id": str(invite.channel_id),
                "user_id": str(current_user.id),
                "display_name": current_user.display_name,
                "role": invite.role_on_join.value,
            },
        )

    return channel_list_item(channel, invite.role_on_join)
