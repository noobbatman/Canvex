from __future__ import annotations

from pathlib import Path

# backend/ (this file is backend/app/core/migrations.py)
_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def run_pending_migrations() -> None:
    """Apply all pending Alembic migrations up to head.

    Runs synchronously — alembic's env.py drives its own asyncio loop
    (`asyncio.run`), so this MUST be called from a thread with no running
    event loop (e.g. via ``anyio.to_thread.run_sync`` inside the FastAPI
    lifespan), never directly on the main loop."""
    from alembic import command
    from alembic.config import Config

    # Build the Config WITHOUT the .ini file: env.py only runs fileConfig()
    # (which would reset our JSON logging to alembic's plain format) when a
    # config file is present. script_location is enough for command.upgrade,
    # and env.py sets sqlalchemy.url from settings itself.
    config = Config()
    config.set_main_option("script_location", str(_BACKEND_ROOT / "alembic"))
    command.upgrade(config, "head")
