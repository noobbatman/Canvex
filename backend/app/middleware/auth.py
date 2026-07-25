from __future__ import annotations

from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.logging import user_id_var
from app.db.session import get_db
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


async def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "access":
            raise credentials_error
        user_id = UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise credentials_error from None

    user = await db.get(User, user_id)
    if user is None:
        raise credentials_error

    # Tag every subsequent log line in this request with the acting user.
    # The contextvar covers logs inside the endpoint's task; request.state
    # carries it across the task boundary to the access-log middleware.
    user_id_var.set(str(user.id))
    request.state.user_id = str(user.id)
    return user
