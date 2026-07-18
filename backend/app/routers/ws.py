from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from jose import JWTError, jwt
from pydantic import ValidationError
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import decode_share_token
from app.db.session import AsyncSessionLocal
from app.db.session import get_db
from app.middleware.auth import get_current_user
from app.models.channel import ChannelMember
from app.models.enums import MemberRole
from app.models.user import User
from app.schemas.whiteboard import ElementCreate, ElementRead, ElementUpdate
from app.services.ai import detect_ai_trigger, enqueue_ai_analysis, enqueue_text_embedding, page_ai_channel
from app.services.analytics import record_canvas_time
from app.services.audit import end_active_session, get_or_create_active_session, record_session_event
from app.services.elements import (
    assert_minimum_role,
    create_element_for_page,
    delete_element_state,
    get_channel_membership_for_user,
    get_element_or_404,
    get_page_or_404,
    update_element_state,
)
from app.services.redis import assert_no_foreign_lock, get_redis, lock_key
from app.services.webhooks import dispatch_webhook_event_for_page
from app.services.ws_manager import manager

router = APIRouter(tags=["websocket"])

LOCK_TTL_SECONDS = 10
CURSOR_TTL_SECONDS = 5


def cursor_key(page_id: UUID) -> str:
    return f"cursor:{page_id}"


def ai_trigger_key(element_id: UUID, trigger_type: object) -> str:
    return f"ai:trigger:{element_id}:{trigger_type}"


async def authenticate_websocket_user(db: AsyncSession, token: str | None) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing access token")
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "access":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
        user_id = UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token") from None

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    return user


async def get_page_membership(db: AsyncSession, page_id: UUID, user_id: UUID) -> ChannelMember:
    page = await get_page_or_404(db, page_id)
    return await get_channel_membership_for_user(db, page.channel_id, user_id)


def element_payload(element: object) -> dict[str, Any]:
    return ElementRead.model_validate(element).model_dump(mode="json")


async def apply_element_operation(
    db: AsyncSession,
    redis: Redis,
    *,
    page_id: UUID,
    user_id: UUID,
    operation_payload: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    membership = await get_page_membership(db, page_id, user_id)
    assert_minimum_role(membership, MemberRole.EDITOR)

    operation = operation_payload.get("operation") or operation_payload.get("op")
    vector_clock = operation_payload.get("vector_clock") or {}

    if operation == "create":
        create_payload = ElementCreate.model_validate(
            {
                **dict(operation_payload.get("element") or operation_payload.get("data") or {}),
                "vector_clock": vector_clock,
            }
        )
        element = await create_element_for_page(db, page_id=page_id, payload=create_payload, actor_id=user_id)
        await db.commit()
        await db.refresh(element)
        payload = element_payload(element)
        with suppress(Exception):
            await dispatch_webhook_event_for_page(db, page_id=page_id, event_type="element:create", payload=payload)
        return "create", payload

    element_id = UUID(str(operation_payload.get("element_id") or operation_payload.get("id")))
    element = await get_element_or_404(db, element_id)
    if element.page_id != page_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Element not found on this page")
    await assert_no_foreign_lock(redis, element.id, user_id)

    if operation == "update":
        update_source = dict(operation_payload.get("element") or operation_payload.get("data") or {})
        for field in ("transform", "style", "content"):
            if field in operation_payload:
                update_source[field] = operation_payload[field]
        update_source["vector_clock"] = vector_clock
        update_payload = ElementUpdate.model_validate(update_source)
        await update_element_state(db, element=element, payload=update_payload, actor_id=user_id, role=membership.role)
        await db.commit()
        await db.refresh(element)
        return "update", element_payload(element)

    if operation == "delete":
        # TODO(phase-7): thread vector_clock into delete event logging once delete concurrency is modeled.
        await delete_element_state(db, element=element, actor_id=user_id, role=membership.role)
        await db.commit()
        return "delete", {"id": str(element.id), "page_id": str(page_id), "is_deleted": True}

    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported element operation")


async def send_error(websocket: WebSocket, exc: Exception, *, client_operation_id: str | None = None) -> None:
    body: dict[str, Any] = {"type": "element:error"}
    if client_operation_id is not None:
        body["client_operation_id"] = client_operation_id
    if isinstance(exc, HTTPException):
        body.update(status=exc.status_code, detail=exc.detail)
    elif isinstance(exc, (ValidationError, ValueError)):
        body.update(status=422, detail=str(exc))
    else:
        body.update(status=500, detail="Element operation failed")
    await websocket.send_json(body)


async def try_send_error(websocket: WebSocket, exc: Exception, *, client_operation_id: str | None = None) -> None:
    try:
        await send_error(websocket, exc, client_operation_id=client_operation_id)
    except RuntimeError:
        pass


async def record_ws_event(
    *,
    session_id: UUID,
    page_id: UUID,
    event_type: str,
    payload: dict[str, Any],
    actor_id: UUID,
) -> None:
    async with AsyncSessionLocal() as db:
        await record_session_event(
            db,
            session_id=session_id,
            page_id=page_id,
            event_type=event_type,
            payload=payload,
            actor_id=actor_id,
        )
        await db.commit()


async def forward_ai_events(websocket: WebSocket, page_id: UUID) -> None:
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    pubsub = redis.pubsub()
    channel = page_ai_channel(page_id)
    await pubsub.subscribe(channel)
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                await websocket.send_json(json.loads(str(message.get("data") or "{}")))
            except RuntimeError:
                break
    finally:
        with suppress(Exception):
            await pubsub.unsubscribe(channel)
            await pubsub.close()
            await redis.aclose()


@router.websocket("/ws/{page_id}")
async def canvas_ws(websocket: WebSocket, page_id: UUID) -> None:
    redis = get_redis()
    token = websocket.query_params.get("token")
    share_token = websocket.query_params.get("share_token")

    user: User | None = None
    read_only = False

    if share_token is not None:
        try:
            shared_page_id = decode_share_token(share_token)
            if shared_page_id != page_id:
                raise ValueError("share token is for a different page")
            async with AsyncSessionLocal() as db:
                await get_page_or_404(db, page_id)
        except Exception:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        read_only = True
    else:
        async with AsyncSessionLocal() as db:
            try:
                user = await authenticate_websocket_user(db, token)
                membership = await get_page_membership(db, page_id, user.id)
                assert_minimum_role(membership, MemberRole.VIEWER)
            except HTTPException:
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return

    if read_only:
        session_id = None
    else:
        async with AsyncSessionLocal() as db:
            session = await get_or_create_active_session(db, page_id)
            await db.commit()
            session_id = session.id

    await manager.connect(websocket, page_id, user.id if user is not None else None, read_only=read_only)
    connected_at = datetime.now(UTC)
    ai_forward_task = asyncio.create_task(forward_ai_events(websocket, page_id))
    if user is not None:
        await manager.broadcast(
            page_id,
            {"type": "presence:join", "payload": {"user_id": str(user.id), "display_name": user.display_name}},
            exclude=websocket,
        )

    try:
        while True:
            message = await websocket.receive_json()
            protocol = message.get("protocol", "canvas")
            if protocol != "canvas":
                await websocket.send_json({"type": "error", "status": 400, "detail": "Unsupported websocket protocol"})
                continue

            if read_only:
                # Share-link viewers are receive-only: they get every
                # broadcast (element:op, ai:response, cursor:move, ...) but
                # can never send a mutating message themselves, regardless of
                # what the frontend does or doesn't show them.
                await websocket.send_json(
                    {
                        "type": "element:error",
                        "status": status.HTTP_403_FORBIDDEN,
                        "detail": "This is a read-only share link.",
                    }
                )
                continue
            message_type = message.get("type")
            payload = dict(message.get("payload") or {})

            if message_type == "cursor:move":
                cursor_payload = {
                    "user_id": str(user.id),
                    "display_name": user.display_name,
                    "x": payload.get("x"),
                    "y": payload.get("y"),
                    "color": payload.get("color"),
                    "updated_at": datetime.now(UTC).isoformat(),
                }
                await redis.hset(cursor_key(page_id), str(user.id), json.dumps(cursor_payload))
                await redis.expire(cursor_key(page_id), CURSOR_TTL_SECONDS)
                # Replay bookkeeping (plan 7.5: cursor moves are part of the
                # session recording). Best-effort, like lock/op recording.
                with suppress(Exception):
                    await record_ws_event(
                        session_id=session_id,
                        page_id=page_id,
                        event_type="cursor:move",
                        payload=cursor_payload,
                        actor_id=user.id,
                    )
                await manager.broadcast(page_id, {"type": "cursor:move", "payload": cursor_payload}, exclude=websocket)

            elif message_type == "element:lock":
                try:
                    async with AsyncSessionLocal() as db:
                        membership = await get_page_membership(db, page_id, user.id)
                        assert_minimum_role(membership, MemberRole.EDITOR)
                        element_id = UUID(str(payload["element_id"]))
                        element = await get_element_or_404(db, element_id)
                        if element.page_id != page_id:
                            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Element not found on this page")
                        await assert_no_foreign_lock(redis, element_id, user.id)
                        await redis.set(lock_key(element_id), str(user.id), ex=LOCK_TTL_SECONDS)
                        manager.remember_lock(websocket, element_id)
                    lock_payload = {"element_id": str(element_id), "locked_by": str(user.id), "ttl_s": LOCK_TTL_SECONDS}
                    # The Redis lock is already set: a replay-logging failure must not
                    # block the ack/broadcast for a lock that already took effect.
                    with suppress(Exception):
                        await record_ws_event(
                            session_id=session_id,
                            page_id=page_id,
                            event_type="element:lock",
                            payload=lock_payload,
                            actor_id=user.id,
                        )
                    await websocket.send_json({"type": "element:lock:ack", "payload": lock_payload})
                    await manager.broadcast(page_id, {"type": "element:lock", "payload": lock_payload}, exclude=websocket)
                except Exception as exc:
                    await try_send_error(websocket, exc)

            elif message_type == "element:op":
                try:
                    async with AsyncSessionLocal() as db:
                        operation, element_data = await apply_element_operation(
                            db,
                            redis,
                            page_id=page_id,
                            user_id=user.id,
                            operation_payload=payload,
                        )
                    event = {"type": "element:op", "operation": operation, "payload": element_data}
                    ack = {"type": "element:ack", "operation": operation, "payload": element_data}
                    if payload.get("client_operation_id") is not None:
                        ack["client_operation_id"] = payload["client_operation_id"]
                    # Session-event recording is best-effort replay bookkeeping: the
                    # element mutation above already committed, so a failure here must
                    # not prevent the ack/broadcast for a change that already happened.
                    with suppress(Exception):
                        await record_ws_event(
                            session_id=session_id,
                            page_id=page_id,
                            event_type="element:op",
                            payload={"operation": operation, "payload": element_data},
                            actor_id=user.id,
                        )
                    if operation in {"create", "update"}:
                        if element_data.get("type") in {"text", "math", "sticky"}:
                            with suppress(Exception):
                                await enqueue_text_embedding(element_id=UUID(str(element_data["id"])))
                        trigger_type = detect_ai_trigger(operation, element_data)
                        if trigger_type is not None:
                            with suppress(Exception):
                                element_id = UUID(str(element_data["id"]))
                                should_enqueue = await redis.set(
                                    ai_trigger_key(element_id, trigger_type.value),
                                    "1",
                                    ex=10,
                                    nx=True,
                                )
                                if should_enqueue:
                                    await enqueue_ai_analysis(
                                        page_id=page_id,
                                        trigger_element_id=element_id,
                                        trigger_type=trigger_type,
                                        snapshot_b64=payload.get("snapshot_b64")
                                        if isinstance(payload.get("snapshot_b64"), str)
                                        else None,
                                    )
                    await websocket.send_json(ack)
                    await manager.broadcast(page_id, event, exclude=websocket)
                except Exception as exc:
                    client_operation_id = payload.get("client_operation_id")
                    await try_send_error(
                        websocket,
                        exc,
                        client_operation_id=client_operation_id if isinstance(client_operation_id, str) else None,
                    )

            else:
                await websocket.send_json({"type": "error", "status": 400, "detail": "Unsupported message type"})

    except WebSocketDisconnect:
        pass
    finally:
        ai_forward_task.cancel()
        with suppress(asyncio.CancelledError):
            await ai_forward_task
        released_locks = manager.disconnect(websocket, page_id)
        if user is not None:
            await redis.hdel(cursor_key(page_id), str(user.id))
            duration_seconds = int((datetime.now(UTC) - connected_at).total_seconds())
            if duration_seconds > 0:
                with suppress(Exception):
                    async with AsyncSessionLocal() as db:
                        await record_canvas_time(db, page_id=page_id, user_id=user.id, seconds=duration_seconds)
                        await db.commit()
            for element_id in released_locks:
                if await redis.get(lock_key(element_id)) == str(user.id):
                    await redis.delete(lock_key(element_id))
                    unlock_payload = {"element_id": str(element_id), "unlocked_by": str(user.id)}
                    # A logging failure here must not abort the rest of disconnect
                    # cleanup (other locks, presence broadcast, session end).
                    with suppress(Exception):
                        await record_ws_event(
                            session_id=session_id,
                            page_id=page_id,
                            event_type="element:unlock",
                            payload=unlock_payload,
                            actor_id=user.id,
                        )
                    await manager.broadcast(
                        page_id,
                        {"type": "element:unlock", "payload": unlock_payload},
                        exclude=websocket,
                    )
            await manager.broadcast(page_id, {"type": "presence:leave", "payload": {"user_id": str(user.id)}}, exclude=websocket)
        if not manager.has_active_editors(page_id):
            async with AsyncSessionLocal() as db:
                ended_session = await end_active_session(db, page_id)
                await db.commit()
                if ended_session is not None:
                    with suppress(Exception):
                        await dispatch_webhook_event_for_page(
                            db,
                            page_id=page_id,
                            event_type="session:end",
                            payload={
                                "session_id": str(ended_session.id),
                                "page_id": str(page_id),
                                "started_at": ended_session.started_at.isoformat(),
                                "ended_at": ended_session.ended_at.isoformat(),
                            },
                        )


@router.get("/pages/{page_id}/presence")
async def get_presence(
    page_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    membership = await get_page_membership(db, page_id, current_user.id)
    assert_minimum_role(membership, MemberRole.VIEWER)
    count = await get_redis().hlen(cursor_key(page_id))
    return {"count": count}
