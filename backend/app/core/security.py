from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from jose import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(user_id: UUID) -> str:
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {
        "sub": str(user_id),
        "exp": expires_at,
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def refresh_token_expires_at() -> datetime:
    return datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)


def create_share_token(page_id: UUID, expires_in_hours: int) -> tuple[str, datetime]:
    """Stateless read-only share link token, per plan 10.6 — no DB row, no
    revocation beyond letting the expiry pass (same trade-off as access
    tokens elsewhere in this app)."""
    expires_at = datetime.now(UTC) + timedelta(hours=expires_in_hours)
    payload = {
        "page_id": str(page_id),
        "read_only": True,
        "type": "share",
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return token, expires_at


def decode_share_token(token: str) -> UUID:
    """Raises jose.JWTError/KeyError/ValueError for any invalid, expired, or
    wrong-type token — callers decide how to translate that (HTTP 401, WS
    policy-violation close, etc.)."""
    payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    if payload.get("type") != "share" or payload.get("read_only") is not True:
        raise ValueError("Not a valid share token")
    return UUID(str(payload["page_id"]))
