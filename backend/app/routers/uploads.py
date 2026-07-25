from __future__ import annotations

import secrets
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from PIL import Image, UnidentifiedImageError

from app.config import settings
from app.core.rate_limit import limiter, user_or_ip
from app.middleware.auth import get_current_user
from app.models.user import User

router = APIRouter()

# backend/uploads — served read-only via the /uploads static mount in main.py.
UPLOADS_DIR = Path(__file__).resolve().parents[2] / "uploads"

# Extension is chosen from the *detected* image format, never the client MIME.
PIL_FORMAT_EXT = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_IMAGE_DIMENSION = 10000


@router.post("/uploads", status_code=status.HTTP_201_CREATED)
@limiter.limit("20/minute", key_func=user_or_ip)  # storage abuse
async def upload_image(
    request: Request,
    file: UploadFile,
    _current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image is larger than 5 MB",
        )
    # Validate by actual content — a spoofed Content-Type must not get through.
    try:
        probe = Image.open(BytesIO(data))
        image_format = probe.format
        width, height = probe.size
        probe.verify()  # confirms the bytes are a well-formed image
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="File is not a valid image"
        ) from None
    extension = PIL_FORMAT_EXT.get(image_format or "")
    if extension is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only PNG, JPEG, WebP, or GIF images are allowed",
        )
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Image dimensions are too large"
        )
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    # Random server-side name: never trust the client filename.
    name = f"{secrets.token_hex(16)}{extension}"
    (UPLOADS_DIR / name).write_bytes(data)
    return {"url": f"{settings.api_base_url.rstrip('/')}/uploads/{name}"}
