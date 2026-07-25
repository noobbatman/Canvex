from __future__ import annotations

import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import request_id_var

logger = logging.getLogger("canvex.request")

# The interactive docs load their scripts from a CDN — a strict CSP would
# blank them out. Everything else on this API serves JSON only.
_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}
_API_CSP = "default-src 'none'; frame-ancestors 'none'"


def _redact_path(path: str) -> str:
    """Keep bearer secrets out of access logs: the share JWT in /view/{token}
    and the join code in /invites/{code} are credentials, not identifiers."""
    parts = path.split("/")
    if len(parts) >= 3 and parts[1] in {"view", "invites"}:
        parts[2] = "<redacted>"
    return "/".join(parts)


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request ID, times the request, and emits one JSON access-log
    line per request. The ID is returned in X-Request-ID so users can quote it
    when reporting errors.

    Context notes: call_next runs the endpoint in a child task, so contextvars
    set inside it (e.g. the authenticated user) do NOT propagate back here —
    request.state (the shared ASGI scope) is the channel that does. The
    request ID is stashed there too so the outermost exception handler can
    still read it after this middleware's context is gone."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = uuid.uuid4().hex
        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            # Emitted while the request-id context is still set, for both the
            # success and the exception path.
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            extra: dict[str, object] = {
                "method": request.method,
                "path": _redact_path(request.url.path),
                "status": status_code,
                "duration_ms": duration_ms,
            }
            authed_user = getattr(request.state, "user_id", None)
            if authed_user:
                extra["user_id"] = authed_user
            logger.log(
                logging.ERROR if status_code >= 500 else logging.INFO,
                "request",
                extra=extra,
            )
            request_id_var.reset(token)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        for header, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(header, value)
        if not request.url.path.startswith(_DOCS_PATHS):
            response.headers.setdefault("Content-Security-Policy", _API_CSP)
        return response
