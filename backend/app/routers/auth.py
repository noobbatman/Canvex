from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import email_is_institutional, settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_password,
    hash_refresh_token,
    refresh_token_expires_at,
    verify_password,
)
from app.db.session import get_db
from app.core.rate_limit import limiter
from app.middleware.auth import get_current_user
from app.models.auth import RefreshToken
from app.models.user import User
from app.schemas.auth import (
    AuthConfig,
    AuthResponse,
    GoogleAuthRequest,
    LogoutRequest,
    RefreshTokenRequest,
    RegisterRequest,
    TokenResponse,
    UserRead,
)

router = APIRouter(prefix="/auth", tags=["auth"])
DUMMY_PASSWORD_HASH = hash_password("canvex-dummy-password")


def token_expires_in_seconds() -> int:
    return settings.access_token_expire_minutes * 60


async def issue_token_pair(db: AsyncSession, user: User) -> TokenResponse:
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=refresh_token_expires_at(),
        )
    )
    await db.flush()
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=token_expires_in_seconds(),
    )


async def revoke_all_refresh_tokens(db: AsyncSession, user_id: UUID) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id)
        .where(RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )


async def create_password_user(
    db: AsyncSession, *, email: str, display_name: str, password: str
) -> AuthResponse:
    """Create an email+password account and return a fresh token pair. Shared by
    the standard and institutional registration endpoints."""
    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is already registered")

    user = User(
        email=email,
        display_name=display_name,
        password_hash=await anyio.to_thread.run_sync(hash_password, password),
    )
    db.add(user)

    try:
        await db.flush()
        tokens = await issue_token_pair(db, user)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is already registered") from None

    return AuthResponse(user=UserRead.model_validate(user), **tokens.model_dump())


def _verify_google_token(credential: str) -> dict:
    """Verify a Google ID token against the configured client ID and return its
    claims. Raises ValueError for any invalid, expired, or wrong-audience token.
    Fetches Google's signing certs over the network, so run it in a thread."""
    return google_id_token.verify_oauth2_token(
        credential, google_requests.Request(), settings.google_client_id
    )


@router.get("/config", response_model=AuthConfig)
async def auth_config() -> AuthConfig:
    """Public: tells the frontend which social sign-in options to render and how
    to validate them. The Google client ID is public by design."""
    return AuthConfig(
        google_enabled=bool(settings.google_client_id),
        google_client_id=settings.google_client_id,
        institutional_domains=settings.institutional_email_domains,
    )


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")  # plan 12.2: prevent account spam
async def register(request: Request, payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> AuthResponse:
    return await create_password_user(
        db, email=payload.email, display_name=payload.display_name, password=payload.password
    )


@router.post("/institutional/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def institutional_register(
    request: Request, payload: RegisterRequest, db: AsyncSession = Depends(get_db)
) -> AuthResponse:
    if not email_is_institutional(payload.email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Use your institutional email address to sign up here.",
        )
    return await create_password_user(
        db, email=payload.email, display_name=payload.display_name, password=payload.password
    )


@router.post("/google", response_model=AuthResponse)
@limiter.limit("10/minute")
async def google_auth(
    request: Request, payload: GoogleAuthRequest, db: AsyncSession = Depends(get_db)
) -> AuthResponse:
    if not settings.google_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured on the server.",
        )
    try:
        claims = await anyio.to_thread.run_sync(_verify_google_token, payload.credential)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Google sign-in failed. Please try again."
        ) from None

    if not claims.get("email") or not claims.get("email_verified"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Your Google account has no verified email."
        )

    email = str(claims["email"]).strip().lower()
    google_sub = str(claims["sub"])
    display_name = str(claims.get("name") or email.split("@")[0])
    picture = claims.get("picture")

    # Find by Google id first, then link to an existing same-email account
    # (safe — Google verified this email), otherwise create a passwordless user.
    user = await db.scalar(select(User).where(User.google_sub == google_sub))
    if user is None:
        user = await db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, display_name=display_name, google_sub=google_sub, avatar_url=picture)
            db.add(user)
        else:
            user.google_sub = google_sub
            if not user.avatar_url and picture:
                user.avatar_url = picture

    try:
        await db.flush()
        tokens = await issue_token_pair(db, user)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That account is linked to a different sign-in method.",
        ) from None

    return AuthResponse(user=UserRead.model_validate(user), **tokens.model_dump())


@router.post("/token", response_model=TokenResponse)
@limiter.limit("10/minute")  # slow down credential-stuffing attempts
async def login(
    request: Request,
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    email = form.username.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    # Google-only accounts have password_hash = NULL; fall back to the dummy hash
    # so verification returns a clean 401 instead of crashing inside passlib.
    stored_hash = user.password_hash if user is not None and user.password_hash else DUMMY_PASSWORD_HASH
    password_is_valid = await anyio.to_thread.run_sync(verify_password, form.password, stored_hash)
    if user is None or not password_is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    tokens = await issue_token_pair(db, user)
    await db.commit()
    return tokens


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshTokenRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    token_hash = hash_refresh_token(payload.refresh_token)
    # Lock the row so two concurrent refreshes serialise: the second waits, then
    # sees revoked=True and trips reuse detection instead of both rotating.
    token_row = await db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
    )

    if token_row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    if token_row.revoked:
        await revoke_all_refresh_tokens(db, token_row.user_id)
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token was already used")

    if token_row.expires_at <= datetime.now(UTC):
        token_row.revoked = True
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token has expired")

    user = await db.get(User, token_row.user_id)
    if user is None:
        token_row.revoked = True
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    token_row.revoked = True
    tokens = await issue_token_pair(db, user)
    await db.commit()
    return tokens


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: LogoutRequest, db: AsyncSession = Depends(get_db)) -> Response:
    token_hash = hash_refresh_token(payload.refresh_token)
    token_row = await db.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    if token_row is not None:
        token_row.revoked = True
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user
