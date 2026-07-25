from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def user_or_ip(request: Request) -> str:
    """Keys authenticated requests by their bearer token (i.e. per user
    session) and anonymous ones by client IP. Used for the AI-cost limits the
    plan wants enforced per user, not per address."""
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()[-32:]
    return get_remote_address(request)


# Plan 12.2: 10 requests/second per IP for the general API. Route-specific
# limits (registration, AI, uploads) are decorated on their endpoints.
limiter = Limiter(key_func=get_remote_address, default_limits=["10/second"])
