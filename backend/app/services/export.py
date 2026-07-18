from __future__ import annotations

import io
import math
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from app.models.element import WhiteboardElement

PADDING = 40
DEFAULT_CANVAS_SIZE = (1000, 700)
BACKGROUND_COLOR = (250, 249, 246, 255)

_FONT_CACHE: dict[int, ImageFont.FreeTypeFont] = {}


def _font(size: int) -> ImageFont.FreeTypeFont:
    size = max(8, min(int(size), 200))
    if size not in _FONT_CACHE:
        _FONT_CACHE[size] = ImageFont.load_default(size=size)
    return _FONT_CACHE[size]


def _resolved_fill(style: dict[str, Any]) -> str | None:
    fill = style.get("fill")
    if not fill or str(fill).strip().lower() == "transparent":
        return None
    return fill


def _points(raw: Any) -> list[tuple[float, float]]:
    """Parse a stroke's Polyline-style points: a list of {x, y} dicts (or
    [x, y] pairs)."""
    if not isinstance(raw, list):
        return []
    points: list[tuple[float, float]] = []
    for item in raw:
        if isinstance(item, dict):
            points.append((float(item.get("x", 0) or 0), float(item.get("y", 0) or 0)))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            points.append((float(item[0]), float(item[1])))
    return points


def _line_endpoints(raw: Any) -> list[tuple[float, float]]:
    """Parse an arrow's Fabric Line-style points: a flat [x1, y1, x2, y2]
    array, not a list of point objects like a Polyline's."""
    if not isinstance(raw, list) or len(raw) < 4:
        return []
    try:
        x1, y1, x2, y2 = (float(v) for v in raw[:4])
    except (TypeError, ValueError):
        return []
    return [(x1, y1), (x2, y2)]


def _wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if font.getlength(candidate) <= max(max_width - 8, 10):
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _draw_arrowhead(
    draw: ImageDraw.ImageDraw,
    from_point: tuple[float, float],
    to_point: tuple[float, float],
    color: str,
    width: int,
) -> None:
    angle = math.atan2(to_point[1] - from_point[1], to_point[0] - from_point[0])
    size = 6 + width * 2
    left = (
        to_point[0] - size * math.cos(angle - math.pi / 6),
        to_point[1] - size * math.sin(angle - math.pi / 6),
    )
    right = (
        to_point[0] - size * math.cos(angle + math.pi / 6),
        to_point[1] - size * math.sin(angle + math.pi / 6),
    )
    draw.polygon([to_point, left, right], fill=color)


def _draw_element_tile(element: WhiteboardElement) -> tuple[Image.Image, float, float]:
    """Render one element onto its own tightly-fit transparent tile, unrotated.

    Returns (tile, local_x, local_y), where (local_x, local_y) is the tile's
    top-left corner in the element's own local space (i.e. relative to
    transform.x/y == the element's canvas position at rotation=0)."""
    transform = element.transform or {}
    style = element.style or {}
    content = element.content or {}
    element_type = element.type.value

    stroke = style.get("stroke") or "#000000"
    stroke_width = max(1, int(float(style.get("strokeWidth", 2) or 2)))
    fill = _resolved_fill(style)
    scale_x = float(transform.get("scaleX", 1) or 1)
    scale_y = float(transform.get("scaleY", 1) or 1)

    if element_type == "rect":
        w = max(1, int(float(content.get("width", 140) or 140) * scale_x))
        h = max(1, int(float(content.get("height", 90) or 90) * scale_y))
        margin = stroke_width
        tile = Image.new("RGBA", (w + margin * 2, h + margin * 2), (0, 0, 0, 0))
        ImageDraw.Draw(tile).rectangle(
            [margin, margin, margin + w, margin + h], outline=stroke, width=stroke_width, fill=fill
        )
        return tile, -margin, -margin

    if element_type == "ellipse":
        w = max(1, int(float(content.get("rx", 60) or 60) * 2 * scale_x))
        h = max(1, int(float(content.get("ry", 40) or 40) * 2 * scale_y))
        margin = stroke_width
        tile = Image.new("RGBA", (w + margin * 2, h + margin * 2), (0, 0, 0, 0))
        ImageDraw.Draw(tile).ellipse(
            [margin, margin, margin + w, margin + h], outline=stroke, width=stroke_width, fill=fill
        )
        return tile, -margin, -margin

    if element_type in {"text", "math", "sticky"}:
        text = str(content.get("text") or "")
        font_size = max(8, int(float(content.get("fontSize", 20) or 20) * min(scale_x, scale_y)))
        width = max(20, int(float(content.get("width", 240) or 240) * scale_x))
        font = _font(font_size)
        lines = _wrap_text(text, font, width) or [""]
        line_height = int(font_size * 1.3)
        height = max(line_height * len(lines), line_height)
        tile = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(tile)
        if element_type == "sticky":
            background = str(content.get("backgroundColor") or "") or fill or "#fef08a"
            draw.rectangle([0, 0, width - 1, height - 1], fill=background, outline=stroke, width=1)
        for i, line in enumerate(lines):
            draw.text((4, i * line_height), line, fill=stroke, font=font)
        return tile, 0, 0

    if element_type in {"stroke", "arrow"}:
        points = _line_endpoints(content.get("points")) if element_type == "arrow" else _points(content.get("points"))
        if len(points) < 2:
            return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0, 0
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        min_x, min_y = min(xs), min(ys)
        margin = stroke_width + 6
        w = max(1, int(math.ceil(max(xs) - min_x)) + margin * 2)
        h = max(1, int(math.ceil(max(ys) - min_y)) + margin * 2)
        tile = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(tile)
        shifted = [(px - min_x + margin, py - min_y + margin) for px, py in points]
        draw.line(shifted, fill=stroke, width=stroke_width, joint="curve")
        if element_type == "arrow":
            _draw_arrowhead(draw, shifted[-2], shifted[-1], stroke, stroke_width)
        # Points are normalized into the tile's own pixel space above (shape's
        # own min sits at `margin`), so the anchor is just -margin — same
        # convention as rect/ellipse. transform.x/y is Fabric's authoritative,
        # continuously-updated bounding-box position; the raw point values
        # (which Fabric does NOT rewrite on every drag) must never be used as
        # an additional canvas offset, or the shape drifts from its real
        # on-canvas position after being moved.
        return tile, -margin, -margin

    # image / link / anything else the app doesn't otherwise render on-canvas
    # yet: a clearly-labeled placeholder rather than silently dropping it.
    width, height = 160, 100
    tile = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rectangle([0, 0, width - 1, height - 1], outline=stroke, width=2)
    draw.text((8, 8), f"[{element_type}]", fill=stroke, font=_font(16))
    return tile, 0, 0


def render_page_image(elements: list[WhiteboardElement]) -> Image.Image:
    prepared: list[tuple[Image.Image, float, float]] = []
    for element in elements:
        transform = element.transform or {}
        x = float(transform.get("x", 0) or 0)
        y = float(transform.get("y", 0) or 0)
        rotation = float(transform.get("rotation", 0) or 0)

        tile, local_x, local_y = _draw_element_tile(element)
        if tile.width <= 0 or tile.height <= 0:
            continue

        # Rotate around the tile's own center, then re-anchor so that center
        # stays at the same canvas point rotation would leave it at.
        center_x = x + local_x + tile.width / 2
        center_y = y + local_y + tile.height / 2
        if rotation:
            tile = tile.rotate(-rotation, expand=True, resample=Image.BICUBIC)
        top_left_x = center_x - tile.width / 2
        top_left_y = center_y - tile.height / 2
        prepared.append((tile, top_left_x, top_left_y))

    if not prepared:
        return Image.new("RGB", DEFAULT_CANVAS_SIZE, BACKGROUND_COLOR[:3])

    min_x = min(p[1] for p in prepared)
    min_y = min(p[2] for p in prepared)
    max_x = max(p[1] + p[0].width for p in prepared)
    max_y = max(p[2] + p[0].height for p in prepared)

    canvas_width = max(200, int(math.ceil(max_x - min_x)) + PADDING * 2)
    canvas_height = max(200, int(math.ceil(max_y - min_y)) + PADDING * 2)
    offset_x = PADDING - min_x
    offset_y = PADDING - min_y

    canvas = Image.new("RGBA", (canvas_width, canvas_height), BACKGROUND_COLOR)
    for tile, top_left_x, top_left_y in prepared:
        paste_x = int(round(top_left_x + offset_x))
        paste_y = int(round(top_left_y + offset_y))
        canvas.alpha_composite(tile, (paste_x, paste_y))

    return canvas.convert("RGB")


def render_page_png(elements: list[WhiteboardElement]) -> bytes:
    buffer = io.BytesIO()
    render_page_image(elements).save(buffer, format="PNG")
    return buffer.getvalue()


def render_page_pdf(elements: list[WhiteboardElement]) -> bytes:
    buffer = io.BytesIO()
    render_page_image(elements).save(buffer, format="PDF")
    return buffer.getvalue()
