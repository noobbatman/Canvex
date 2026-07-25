from __future__ import annotations

import hashlib
import hmac
import json
import logging
from datetime import UTC, datetime
from uuid import UUID

import anyio
import httpx
from arq import Retry
from arq.worker import func

from app.core.ssrf import webhook_url_is_safe
from app.db.session import AsyncSessionLocal
from app.models.webhook import Webhook
from app.services.webhooks import redis_settings

logger = logging.getLogger("canvex.webhook")

# One retry per delay, in order: fails at try 1 -> wait 5s -> try 2 -> wait 25s
# -> try 3 -> wait 125s -> try 4 -> give up. 3 retries total, per plan 10.4.
RETRY_DELAYS_SECONDS = [5, 25, 125]
DELIVERY_TIMEOUT_SECONDS = 10.0


async def deliver_webhook(ctx: dict, *, webhook_id: str, event_type: str, payload: dict) -> None:
    async with AsyncSessionLocal() as db:
        webhook = await db.get(Webhook, UUID(webhook_id))
        if webhook is None or not webhook.is_active:
            return

        # SSRF guard: never deliver to a target that resolves to a private,
        # loopback, or cloud-metadata address (re-checked here, not just at
        # creation, so DNS can't be rebound to an internal host after the fact).
        if not await anyio.to_thread.run_sync(webhook_url_is_safe, webhook.target_url):
            logger.warning("Refusing webhook delivery to non-public target: %s", webhook.target_url)
            return

        body = json.dumps({"event_type": event_type, "payload": payload}, default=str).encode("utf-8")
        signature = hmac.new(webhook.signing_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()

        try:
            async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS, follow_redirects=False) as client:
                response = await client.post(
                    webhook.target_url,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Canvex-Event": event_type,
                        "X-Canvex-Signature": f"sha256={signature}",
                    },
                )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            attempt = ctx["job_try"]  # 1-indexed; this is the try that just failed
            if attempt > len(RETRY_DELAYS_SECONDS):
                # Exhausted all retries. There's no delivery-log table in the
                # schema to record the failure in, so this is the end of the
                # line for this event — last_delivery_at simply isn't touched.
                return
            raise Retry(defer=RETRY_DELAYS_SECONDS[attempt - 1]) from exc

        webhook.last_delivery_at = datetime.now(UTC)
        await db.commit()


class WorkerSettings:
    functions = [func(deliver_webhook, max_tries=len(RETRY_DELAYS_SECONDS) + 1)]
    redis_settings = redis_settings()
