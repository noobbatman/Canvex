from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

# Supabase / other external Postgres require SSL; Render's internal URL doesn't.
_connect_args = {"ssl": settings.database_ssl} if settings.database_ssl else {}

engine = create_async_engine(
    settings.database_url,
    # echo=True writes plain text around the JSON logging config (12.4); to
    # see SQL in development, raise the 'sqlalchemy.engine' logger level
    # instead — it flows through the structured handler.
    echo=False,
    pool_pre_ping=True,
    # Plan 12.5: up to 30 concurrent connections; a timeout here surfacing in
    # logs means queries are holding connections too long.
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
    connect_args=_connect_args,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession,
)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
