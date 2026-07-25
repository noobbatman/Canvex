from __future__ import annotations

import json
import logging
from contextvars import ContextVar
from datetime import UTC, datetime

# Threaded through every log line emitted while handling one request.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

# LogRecord attributes that are internal plumbing, not user-supplied extras.
_RESERVED_RECORD_KEYS = frozenset(
    {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "taskName", "message",
    }
)


class JsonFormatter(logging.Formatter):
    """One JSON object per line: what Render/Railway log aggregators expect."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            entry["request_id"] = request_id
        user_id = user_id_var.get()
        if user_id:
            entry["user_id"] = user_id
        # `extra={...}` fields land on the record directly — surface them.
        for key, value in record.__dict__.items():
            if key not in _RESERVED_RECORD_KEYS and key not in entry:
                try:
                    json.dumps(value)
                except (TypeError, ValueError):
                    value = repr(value)
                entry[key] = value
        if record.exc_info:
            entry["traceback"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def setup_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # Route uvicorn's loggers through the JSON handler; drop its plaintext
    # access log (our request middleware emits a richer JSON line instead).
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
    # httpx/httpcore log every outbound request at INFO (webhook worker,
    # Gemini calls) — redundant with our own delivery logging. Quiet them so
    # the structured log stays signal, not chatter.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
