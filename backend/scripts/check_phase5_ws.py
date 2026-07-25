from __future__ import annotations
# ruff: noqa: E402

import sys
import time
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from app.db.session import AsyncSessionLocal, engine
from app.main import app
from app.models.audit import ElementEvent
from app.models.enums import EventOperation
from app.routers.ws import try_send_error


class DeadWebSocket:
    async def send_json(self, payload: object) -> None:
        raise RuntimeError("WebSocket is not connected")


def require_status(label: str, actual: int, expected: int, body: object) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}: {body}")


def register(client: TestClient, email: str, display_name: str) -> dict[str, str]:
    response = client.post(
        "/auth/register",
        json={"email": email, "display_name": display_name, "password": "correct-horse-42"},
    )
    require_status(f"register {email}", response.status_code, 201, response.text)
    body = response.json()
    return {"access": body["access_token"], "user_id": body["user"]["id"]}


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def load_element_events(element_id: str) -> list[ElementEvent]:
    async with AsyncSessionLocal() as db:
        events = await db.scalars(
            select(ElementEvent)
            .where(ElementEvent.element_id == UUID(element_id))
            .order_by(ElementEvent.occurred_at.asc())
        )
        return list(events.all())


async def assert_dead_socket_error_is_silent() -> None:
    await try_send_error(DeadWebSocket(), RuntimeError("WebSocket is not connected"))


def main() -> None:
    stamp = int(time.time())
    element_id = ""

    with TestClient(app) as client:
        owner = register(client, f"phase5_owner_{stamp}@canvex.local", "Phase Five Owner")
        editor = register(client, f"phase5_editor_{stamp}@canvex.local", "Phase Five Editor")

        response = client.post(
            "/channels",
            json={"name": f"Phase 5 Channel {stamp}", "description": "WebSocket verification"},
            headers=auth(owner["access"]),
        )
        require_status("create channel", response.status_code, 201, response.text)
        channel_id = response.json()["id"]

        response = client.post(
            f"/channels/{channel_id}/invites",
            json={"role_on_join": "editor", "max_uses": 1},
            headers=auth(owner["access"]),
        )
        require_status("create editor invite", response.status_code, 201, response.text)
        invite_code = response.json()["code"]

        response = client.post(f"/invites/{invite_code}/accept", headers=auth(editor["access"]))
        require_status("editor accept invite", response.status_code, 200, response.text)

        response = client.post(
            f"/channels/{channel_id}/pages",
            json={"title": "Realtime canvas"},
            headers=auth(owner["access"]),
        )
        require_status("create page", response.status_code, 201, response.text)
        page_id = response.json()["id"]

        with client.websocket_connect(f"/ws/{page_id}?token={owner['access']}") as owner_ws:
            with client.websocket_connect(f"/ws/{page_id}?token={editor['access']}") as editor_ws:
                join_message = owner_ws.receive_json()
                if join_message["type"] != "presence:join" or join_message["payload"]["user_id"] != editor["user_id"]:
                    raise AssertionError(f"unexpected join message: {join_message}")

                owner_ws.send_json({"type": "cursor:move", "payload": {"x": 12, "y": 34, "color": "#3366ff"}})
                cursor_message = editor_ws.receive_json()
                if cursor_message["type"] != "cursor:move" or cursor_message["payload"]["x"] != 12:
                    raise AssertionError(f"unexpected cursor message: {cursor_message}")

                response = client.get(f"/pages/{page_id}/presence", headers=auth(owner["access"]))
                require_status("presence count", response.status_code, 200, response.text)
                # Two authenticated WebSockets (owner + editor) are connected here.
                if response.json()["count"] != 2:
                    raise AssertionError("presence count should be 2 with both users connected")

                owner_ws.send_json(
                    {
                        "type": "element:op",
                        "payload": {
                            "operation": "create",
                            "client_operation_id": "owner-create-1",
                            "element": {
                                "type": "text",
                                "transform": {"x": 10, "y": 20, "scaleX": 1, "scaleY": 1, "rotation": 0},
                                "style": {"stroke": "#111111", "fill": "transparent", "strokeWidth": 2},
                                "content": {"text": "created over websocket"},
                            },
                            "vector_clock": {"owner-client": 1},
                        },
                    }
                )
                owner_ack = owner_ws.receive_json()
                editor_broadcast = editor_ws.receive_json()
                if owner_ack["type"] != "element:ack" or owner_ack["operation"] != "create":
                    raise AssertionError(f"unexpected owner create ack: {owner_ack}")
                if owner_ack["client_operation_id"] != "owner-create-1":
                    raise AssertionError(f"create ack did not preserve client operation id: {owner_ack}")
                if editor_broadcast["type"] != "element:op" or editor_broadcast["operation"] != "create":
                    raise AssertionError(f"unexpected editor create broadcast: {editor_broadcast}")
                element_id = owner_ack["payload"]["id"]

                editor_ws.send_json(
                    {
                        "type": "element:op",
                        "payload": {
                            "operation": "update",
                            "element_id": element_id,
                            "content": {"text": "updated by editor over websocket"},
                            "vector_clock": {"editor-client": 1},
                        },
                    }
                )
                editor_ack = editor_ws.receive_json()
                owner_broadcast = owner_ws.receive_json()
                if editor_ack["type"] != "element:ack" or editor_ack["payload"]["content"]["text"] != "updated by editor over websocket":
                    raise AssertionError(f"unexpected editor update ack: {editor_ack}")
                if owner_broadcast["type"] != "element:op" or owner_broadcast["operation"] != "update":
                    raise AssertionError(f"unexpected owner update broadcast: {owner_broadcast}")

                owner_ws.send_json({"type": "element:lock", "payload": {"element_id": element_id}})
                lock_ack = owner_ws.receive_json()
                lock_broadcast = editor_ws.receive_json()
                if lock_ack["type"] != "element:lock:ack":
                    raise AssertionError(f"unexpected lock ack: {lock_ack}")
                if lock_broadcast["type"] != "element:lock" or lock_broadcast["payload"]["element_id"] != element_id:
                    raise AssertionError(f"unexpected lock broadcast: {lock_broadcast}")

                editor_ws.send_json(
                    {
                        "type": "element:op",
                        "payload": {
                            "operation": "update",
                            "element_id": element_id,
                            "content": {"text": "this should be blocked by lock"},
                        },
                    }
                )
                lock_error = editor_ws.receive_json()
                if lock_error["type"] != "element:error" or lock_error["status"] != 423:
                    raise AssertionError(f"unexpected lock error: {lock_error}")

        events = client.portal.call(load_element_events, element_id)
        if [event.operation for event in events] != [EventOperation.CREATE, EventOperation.UPDATE]:
            raise AssertionError("WebSocket create/update should write two element event rows")
        if events[0].vector_clock != {"owner-client": 1}:
            raise AssertionError("WebSocket create vector clock was not persisted")
        if events[1].vector_clock != {"editor-client": 1}:
            raise AssertionError("WebSocket update vector clock was not persisted")

        client.portal.call(assert_dead_socket_error_is_silent)
        client.portal.call(engine.dispose)
    print("Phase 5 websocket backend flow passed")


if __name__ == "__main__":
    main()
