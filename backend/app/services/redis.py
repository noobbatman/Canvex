from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from redis.asyncio import Redis

from app.config import settings

_redis_client: Redis | None = None


def get_redis() -> Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def lock_key(element_id: UUID) -> str:
    return f"lock:{element_id}"


async def assert_no_foreign_lock(redis: Redis, element_id: UUID, user_id: UUID) -> None:
    """Raise 423 Locked when another user currently holds the Redis element
    lock. Shared by the WebSocket handler and the REST fallback routes so both
    mutation paths respect the same locks."""
    locked_by = await redis.get(lock_key(element_id))
    if locked_by is not None and locked_by != str(user_id):
        raise HTTPException(status_code=423, detail="Element is locked by another user")
