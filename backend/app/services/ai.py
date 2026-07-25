from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
import time
from contextlib import suppress
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

import anyio
from arq.connections import RedisSettings, create_pool
from redis.asyncio import Redis
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.ai import AIFeedback, AIInteraction
from app.models.element import WhiteboardElement
from app.models.enums import AITriggerType, ElementType
from app.models.page import WhiteboardPage
from app.schemas.whiteboard import ElementCreate
from app.services.element_events import element_state
from app.services.elements import create_element_for_page
from app.services.webhooks import dispatch_webhook_event_for_page

logger = logging.getLogger("canvex.ai")

MATH_PATTERN = re.compile(r"[-+]?\d*\.?\d*\s*x\s*(?:[+-]\s*\d+(?:\.\d+)?)?\s*=\s*[-+]?\d+(?:\.\d+)?", re.I)
AI_RESPONSE_CHANNEL_PREFIX = "ai:response:"
EMBEDDING_DIMENSIONS = 768  # text-embedding-004 output size
TEXT_EMBEDDING_DEBOUNCE_SECONDS = 3.0

_arq_pool = None
_embedding_debounce_tasks: dict[UUID, asyncio.Task] = {}


def redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(settings.redis_url)


async def get_arq_pool():
    global _arq_pool
    if _arq_pool is None:
        _arq_pool = await create_pool(redis_settings())
    return _arq_pool


def page_ai_channel(page_id: UUID | str) -> str:
    return f"{AI_RESPONSE_CHANNEL_PREFIX}{page_id}"


def content_text(content: dict[str, Any]) -> str:
    for key in ("text", "label", "latex", "value"):
        value = content.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def points_are_closed(points: object) -> bool:
    if not isinstance(points, list) or len(points) < 3:
        return False
    first = points[0]
    last = points[-1]
    if not isinstance(first, dict) or not isinstance(last, dict):
        return False
    try:
        distance = math.dist((float(first["x"]), float(first["y"])), (float(last["x"]), float(last["y"])))
    except (KeyError, TypeError, ValueError):
        return False
    return distance <= 10


def detect_ai_trigger(operation: str, element_data: dict[str, Any]) -> AITriggerType | None:
    if operation not in {"create", "update"}:
        return None

    element_type = str(element_data.get("type") or "")
    content = dict(element_data.get("content") or {})
    text = content_text(content)
    lowered = text.lower()

    if lowered.startswith("/ai") or lowered.startswith("*"):
        return AITriggerType.EXPLICIT
    if element_type == ElementType.IMAGE.value and operation == "create":
        return AITriggerType.IMAGE
    if text.endswith("?") or text == "?":
        return AITriggerType.QUESTION
    if element_type == ElementType.STROKE.value and points_are_closed(content.get("points")):
        return AITriggerType.CLOSED_SHAPE
    if element_type in {ElementType.MATH.value, ElementType.TEXT.value, ElementType.STICKY.value} and MATH_PATTERN.search(text):
        return AITriggerType.MATH
    return None


async def enqueue_ai_analysis(
    *,
    page_id: UUID,
    trigger_element_id: UUID,
    trigger_type: AITriggerType,
    snapshot_b64: str | None,
) -> None:
    pool = await get_arq_pool()
    await pool.enqueue_job(
        "analyze_canvas",
        page_id=str(page_id),
        trigger_element_id=str(trigger_element_id),
        trigger_type=trigger_type.value,
        snapshot_b64=snapshot_b64,
    )


async def _run_debounced_text_embedding(element_id: UUID) -> None:
    try:
        await asyncio.sleep(TEXT_EMBEDDING_DEBOUNCE_SECONDS)
        pool = await get_arq_pool()
        await pool.enqueue_job("embed_element_text", element_id=str(element_id))
    finally:
        if _embedding_debounce_tasks.get(element_id) is asyncio.current_task():
            _embedding_debounce_tasks.pop(element_id, None)


async def enqueue_text_embedding(*, element_id: UUID) -> None:
    """Schedule an embedding job, restarting the delay on every call so the
    Gemini embedding API is only hit once typing has stopped for a few
    seconds, instead of on every keystroke/update."""
    pending = _embedding_debounce_tasks.get(element_id)
    if pending is not None and not pending.done():
        pending.cancel()
    _embedding_debounce_tasks[element_id] = asyncio.create_task(_run_debounced_text_embedding(element_id))


def save_snapshot(snapshot_b64: str | None) -> str | None:
    if not snapshot_b64:
        return None
    header, _, data = snapshot_b64.partition(",")
    raw = data if data else header
    try:
        image_bytes = base64.b64decode(raw, validate=True)
    except ValueError:
        return None

    snapshot_dir = Path("storage") / "ai_snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{sha256(image_bytes).hexdigest()[:24]}.png"
    target = snapshot_dir / filename
    target.write_bytes(image_bytes)
    return str(target.as_posix())


async def recent_corrections(db: AsyncSession, channel_id: UUID) -> list[AIFeedback]:
    rows = await db.scalars(
        select(AIFeedback)
        .join(AIInteraction, AIInteraction.id == AIFeedback.interaction_id)
        .join(WhiteboardPage, WhiteboardPage.id == AIInteraction.page_id)
        .where(
            WhiteboardPage.channel_id == channel_id,
            AIFeedback.is_correct.is_(False),
            AIFeedback.correction_text.is_not(None),
        )
        .order_by(desc(AIFeedback.created_at))
        .limit(5)
    )
    return list(rows.all())


async def build_prompt(
    db: AsyncSession,
    *,
    page: WhiteboardPage,
    trigger_element: WhiteboardElement | None,
    trigger_type: AITriggerType,
    trigger_text: str | None = None,
    has_image: bool = False,
) -> str:
    corrections = await recent_corrections(db, page.channel_id)
    if trigger_text is None:
        trigger_text = content_text(dict(trigger_element.content or {})) if trigger_element else ""
    correction_block = "\n".join(
        f"- Prior incorrect answer correction: {feedback.correction_text}" for feedback in corrections
    )
    if not correction_block:
        correction_block = "- No prior corrections for this channel yet."
    image_note = (
        "An image of the user's handwritten notebook canvas is attached. Carefully read any "
        "handwriting, equations, diagrams, and drawings in it — interpret messy or cursive "
        "handwriting as best you can — and use what you see to answer.\n\n"
        if has_image
        else ""
    )

    return f"""You are Canvex AI, an assistant embedded in a collaborative notebook whiteboard.
Answer the user's request directly, correctly, and concisely. If it is a question,
give the actual answer (with a short explanation or steps when useful). Write plain
text suitable to drop onto the canvas — no markdown headers or code fences.

{image_note}Trigger type: {trigger_type.value}
User input: {trigger_text or "(none)"}

Channel-specific corrections to respect:
{correction_block}

Reply with a JSON object only, in this exact shape:
{{"type":"text","content":"your answer"}}
"""


def solve_simple_equation(text: str) -> str | None:
    match = re.search(
        r"(?P<a>[-+]?\d*\.?\d*)\s*x\s*(?P<op>[+-])\s*(?P<b>\d+(?:\.\d+)?)\s*=\s*(?P<c>[-+]?\d+(?:\.\d+)?)",
        text,
        re.I,
    )
    if not match:
        return None
    a_raw = match.group("a")
    if a_raw in {"", "+"}:
        a = 1.0
    elif a_raw == "-":
        a = -1.0
    else:
        a = float(a_raw)
    if a == 0:
        return None
    b = float(match.group("b"))
    c = float(match.group("c"))
    if match.group("op") == "+":
        value = (c - b) / a
        step = f"Subtract {b:g} from both sides: {a:g}x = {c - b:g}."
    else:
        value = (c + b) / a
        step = f"Add {b:g} to both sides: {a:g}x = {c + b:g}."
    return f"{text}\n{step}\nDivide by {a:g}: x = {value:g}."


def local_ai_response(trigger_type: AITriggerType, trigger_text: str) -> dict[str, str]:
    if trigger_type == AITriggerType.MATH:
        solved = solve_simple_equation(trigger_text)
        if solved:
            return {"type": "text", "content": solved}
    if trigger_type == AITriggerType.QUESTION:
        return {"type": "text", "content": f"Good question. I would start by breaking down: {trigger_text}"}
    if trigger_type == AITriggerType.EXPLICIT:
        cleaned = trigger_text.removeprefix("/ai").lstrip("* ").strip()
        return {"type": "text", "content": cleaned or "Tell me what you want me to explain on this canvas."}
    return {"type": "text", "content": "I noticed something worth reviewing here. Add a note or question and I can make the response sharper."}


def parse_gemini_json(raw_text: str) -> dict[str, str]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return {"type": "text", "content": cleaned}
    content = data.get("content")
    if not isinstance(content, str) or not content.strip():
        content = cleaned
    return {"type": str(data.get("type") or "text"), "content": content.strip()}


async def call_gemini_or_local(
    *,
    prompt: str,
    trigger_type: AITriggerType,
    trigger_text: str,
    snapshot_path: str | None,
) -> tuple[dict[str, str], int | None, int | None]:
    if not settings.gemini_api_key:
        response = local_ai_response(trigger_type, trigger_text)
        return response, len(prompt.split()), len(response["content"].split())

    import anyio
    import google.generativeai as genai

    def generate() -> tuple[dict[str, str], int | None, int | None]:
        genai.configure(api_key=settings.gemini_api_key)
        model = genai.GenerativeModel(settings.gemini_vision_model)
        parts: list[Any] = [prompt]
        if snapshot_path:
            parts.append({"mime_type": "image/png", "data": Path(snapshot_path).read_bytes()})
        result = model.generate_content(parts)
        response_text = result.text or ""
        usage = getattr(result, "usage_metadata", None)
        input_tokens = getattr(usage, "prompt_token_count", None)
        output_tokens = getattr(usage, "candidates_token_count", None)
        return parse_gemini_json(response_text), input_tokens, output_tokens

    return await anyio.to_thread.run_sync(generate)


def deterministic_embedding(text: str) -> list[float]:
    vector = [0.0] * EMBEDDING_DIMENSIONS
    for token in re.findall(r"\w+", text.lower()):
        digest = sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMENSIONS
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [value / norm for value in vector]


async def embed_text(text: str) -> list[float]:
    if not settings.gemini_api_key:
        return deterministic_embedding(text)

    import anyio
    import google.generativeai as genai

    def embed() -> list[float]:
        genai.configure(api_key=settings.gemini_api_key)
        result = genai.embed_content(model=settings.gemini_embedding_model, content=text)
        embedding = result.get("embedding") if isinstance(result, dict) else None
        if not isinstance(embedding, list):
            return deterministic_embedding(text)
        return [float(value) for value in embedding[:EMBEDDING_DIMENSIONS]]

    return await anyio.to_thread.run_sync(embed)


async def analyze_canvas_job(
    db: AsyncSession,
    redis: Redis,
    *,
    page_id: UUID,
    trigger_element_id: UUID,
    trigger_type: AITriggerType,
    snapshot_b64: str | None,
) -> AIInteraction:
    started = time.perf_counter()
    page = await db.get(WhiteboardPage, page_id)
    if page is None or page.is_deleted:
        raise ValueError(f"Page {page_id} not found or deleted")
    trigger_element = await db.get(WhiteboardElement, trigger_element_id)
    snapshot_url = save_snapshot(snapshot_b64)
    prompt = await build_prompt(db, page=page, trigger_element=trigger_element, trigger_type=trigger_type)
    interaction = AIInteraction(
        page_id=page_id,
        trigger_element_id=trigger_element_id,
        trigger_type=trigger_type,
        canvas_snapshot_url=snapshot_url,
        prompt_sent=prompt,
        status="pending",
    )
    db.add(interaction)
    await db.flush()

    try:
        trigger_text = content_text(dict(trigger_element.content or {})) if trigger_element else ""
        response_json, input_tokens, output_tokens = await call_gemini_or_local(
            prompt=prompt,
            trigger_type=trigger_type,
            trigger_text=trigger_text,
            snapshot_path=snapshot_url,
        )
        text = response_json.get("content") or "I could not produce a response."
        base_transform = deepcopy(trigger_element.transform) if trigger_element else {}
        transform = {
            "x": float(base_transform.get("x", 120)) + 32,
            "y": float(base_transform.get("y", 120)) + 96,
            "scaleX": 1,
            "scaleY": 1,
            "rotation": 0,
        }
        response_element = await create_element_for_page(
            db,
            page_id=page_id,
            payload=ElementCreate(
                type=ElementType.TEXT,
                transform=transform,
                style={"stroke": "#4f46e5", "fill": "#4f46e5", "strokeWidth": 1},
                content={"text": text, "source": "ai", "interaction_id": str(interaction.id)},
            ),
            actor_id=None,
        )
        response_element.embedding = await embed_text(text)
        await db.flush()
        interaction.response_json = response_json
        interaction.response_element_id = response_element.id
        interaction.input_tokens = input_tokens
        interaction.output_tokens = output_tokens
        interaction.latency_ms = int((time.perf_counter() - started) * 1000)
        interaction.status = "succeeded"
        await db.commit()
        await db.refresh(response_element)

        await redis.publish(
            page_ai_channel(page_id),
            json.dumps(
                {
                    "type": "ai:response",
                    "payload": {
                        "element": {
                            **element_state(response_element),
                            "id": str(response_element.id),
                            "page_id": str(response_element.page_id),
                            "last_event": str(response_element.last_event) if response_element.last_event else None,
                            "created_at": response_element.created_at.isoformat(),
                            "updated_at": response_element.updated_at.isoformat(),
                        },
                        "interaction_id": str(interaction.id),
                        "trigger_type": trigger_type.value,
                    },
                }
            ),
        )
        with suppress(Exception):
            await dispatch_webhook_event_for_page(
                db,
                page_id=page_id,
                event_type="ai:response",
                payload={
                    "element": element_state(response_element),
                    "interaction_id": str(interaction.id),
                    "trigger_type": trigger_type.value,
                },
            )
    except Exception as exc:
        # The failure may be a DB error from the try block (element insert,
        # embedding flush, ...), which leaves the session in a pending-rollback
        # state where a plain commit() would raise and the ledger row would be
        # lost. Roll back first, then write a fresh failure row so every AI
        # attempt is recorded per plan 9.5 — the rollback discards the
        # "pending" row added above.
        await db.rollback()
        interaction = AIInteraction(
            page_id=page_id,
            trigger_element_id=trigger_element_id,
            trigger_type=trigger_type,
            canvas_snapshot_url=snapshot_url,
            prompt_sent=prompt,
            status="failed",
            error_message=str(exc),
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        db.add(interaction)
        await db.commit()
        raise

    return interaction


async def answer_question_now(
    db: AsyncSession,
    *,
    page: WhiteboardPage,
    question: str,
    snapshot_b64: str | None = None,
) -> tuple[AIInteraction, str, str]:
    """Answer a question synchronously, in the request, with no queue/worker.

    Runs Gemini (or the local fallback) inline and records the interaction, then
    returns the answer as text. The answer is deliberately NOT placed on the
    canvas — the caller shows it and lets the user decide whether to add it, so
    the canvas isn't cluttered with unwanted replies. Gemini failures degrade to
    the local fallback so the user always gets an immediate answer."""
    started = time.perf_counter()
    snapshot_url = save_snapshot(snapshot_b64)
    prompt = await build_prompt(
        db,
        page=page,
        trigger_element=None,
        trigger_type=AITriggerType.EXPLICIT,
        trigger_text=question,
        has_image=bool(snapshot_url),
    )
    interaction = AIInteraction(
        page_id=page.id,
        trigger_element_id=None,
        trigger_type=AITriggerType.EXPLICIT,
        canvas_snapshot_url=snapshot_url,
        prompt_sent=prompt,
        status="pending",
    )
    db.add(interaction)
    await db.flush()

    error_message: str | None = None
    try:
        response_json, input_tokens, output_tokens = await call_gemini_or_local(
            prompt=prompt,
            trigger_type=AITriggerType.EXPLICIT,
            trigger_text=question,
            snapshot_path=snapshot_url,
        )
        source = "gemini" if settings.gemini_api_key else "local"
    except Exception as exc:  # bad key/model/network → still answer, but say so
        logger.warning("Gemini ask failed; using local fallback: %s", exc)
        response_json = local_ai_response(AITriggerType.EXPLICIT, question)
        input_tokens = output_tokens = None
        source = "local-fallback"
        error_message = str(exc)[:500]

    text = (response_json.get("content") or "I could not produce a response.").strip()
    interaction.response_json = response_json
    interaction.input_tokens = input_tokens
    interaction.output_tokens = output_tokens
    interaction.latency_ms = int((time.perf_counter() - started) * 1000)
    interaction.status = "succeeded"
    interaction.error_message = error_message
    await db.commit()
    await db.refresh(interaction)
    return interaction, source, text


SOLVE_PROMPT = """You are Canvex AI, embedded in a handwritten notebook whiteboard. An image of the
current page is attached. Read it carefully — interpret messy or cursive handwriting, equations,
and diagrams. Find EVERY question, problem, exercise, or equation on the page that still needs an
answer or solution, and work out the correct answer for each.

Return ONLY a JSON array. Each element must be:
{"problem": "<short label of the problem>", "answer": "<the answer, concise, correct, plain text, no markdown>", "x": <horizontal position of the problem in the image from 0.0 (left) to 1.0 (right)>, "y": <vertical position from 0.0 (top) to 1.0 (bottom)>}

x and y locate the problem in the image so the answer can be dropped next to it. Skip anything that
is already answered. If nothing on the page needs answering, return []."""


def _coord(value: object) -> float | None:
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    # Gemini sometimes returns 0–1000 or 0–100 instead of 0–1; normalise.
    if f > 100:
        f /= 1000.0
    elif f > 1.5:
        f /= 100.0
    return min(1.0, max(0.0, f))


def parse_solve_items(raw_text: str) -> list[dict[str, object]]:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = data.get("answers") or data.get("items") or data.get("problems") or []
    if not isinstance(data, list):
        return []
    items: list[dict[str, object]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        answer = entry.get("answer")
        if not isinstance(answer, str) or not answer.strip():
            continue
        items.append(
            {
                "problem": str(entry.get("problem") or "")[:200],
                "answer": answer.strip(),
                "x": _coord(entry.get("x")),
                "y": _coord(entry.get("y")),
            }
        )
    return items[:20]


def _gemini_vision_text(prompt: str, snapshot_path: str) -> tuple[str, int | None, int | None]:
    import google.generativeai as genai

    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(settings.gemini_vision_model)
    result = model.generate_content(
        [prompt, {"mime_type": "image/png", "data": Path(snapshot_path).read_bytes()}]
    )
    usage = getattr(result, "usage_metadata", None)
    return (
        result.text or "",
        getattr(usage, "prompt_token_count", None),
        getattr(usage, "candidates_token_count", None),
    )


async def solve_page_now(
    db: AsyncSession,
    *,
    page: WhiteboardPage,
    snapshot_b64: str | None,
) -> tuple[str, list[dict[str, object]], int]:
    """Scan a whole page image and answer every problem that needs answering.

    Returns (source, items, latency_ms) where each item is
    {problem, answer, x, y} with x/y as normalised 0–1 positions (or None).
    Needs a Gemini vision model — without a key or snapshot it returns no items."""
    started = time.perf_counter()
    snapshot_url = save_snapshot(snapshot_b64)
    interaction = AIInteraction(
        page_id=page.id,
        trigger_element_id=None,
        trigger_type=AITriggerType.EXPLICIT,
        canvas_snapshot_url=snapshot_url,
        prompt_sent=SOLVE_PROMPT,
        status="pending",
    )
    db.add(interaction)
    await db.flush()

    items: list[dict[str, object]] = []
    input_tokens = output_tokens = None
    error_message: str | None = None
    if not settings.gemini_api_key or not snapshot_url:
        source = "local"  # local mode can't read the page image
        error_message = None if settings.gemini_api_key else "no gemini key"
    else:
        try:
            raw, input_tokens, output_tokens = await anyio.to_thread.run_sync(
                _gemini_vision_text, SOLVE_PROMPT, snapshot_url
            )
            items = parse_solve_items(raw)
            source = "gemini"
        except Exception as exc:  # bad key/model/network
            logger.warning("Gemini page scan failed: %s", exc)
            source = "local-fallback"
            error_message = str(exc)[:500]

    interaction.response_json = {"answers": items}
    interaction.input_tokens = input_tokens
    interaction.output_tokens = output_tokens
    interaction.latency_ms = int((time.perf_counter() - started) * 1000)
    interaction.status = "succeeded"
    interaction.error_message = error_message
    await db.commit()
    return source, items, interaction.latency_ms


async def update_text_embedding_if_needed(db: AsyncSession, element: WhiteboardElement) -> None:
    if element.type not in {ElementType.TEXT, ElementType.MATH, ElementType.STICKY}:
        return
    text = content_text(dict(element.content or {}))
    if not text:
        return
    element.embedding = await embed_text(text)


async def embed_element_text_job(db: AsyncSession, *, element_id: UUID) -> None:
    element = await db.get(WhiteboardElement, element_id)
    if element is None or element.is_deleted:
        return
    await update_text_embedding_if_needed(db, element)
    await db.commit()
