from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: dict[UUID, set[WebSocket]] = defaultdict(set)
        self.connection_users: dict[WebSocket, UUID | None] = {}
        self.connection_locks: dict[WebSocket, set[UUID]] = defaultdict(set)
        self.read_only_connections: set[WebSocket] = set()

    async def connect(
        self, websocket: WebSocket, page_id: UUID, user_id: UUID | None, *, read_only: bool = False
    ) -> None:
        await websocket.accept()
        self.rooms[page_id].add(websocket)
        self.connection_users[websocket] = user_id
        if read_only:
            self.read_only_connections.add(websocket)

    def remember_lock(self, websocket: WebSocket, element_id: UUID) -> None:
        self.connection_locks[websocket].add(element_id)

    def disconnect(self, websocket: WebSocket, page_id: UUID) -> set[UUID]:
        self.rooms[page_id].discard(websocket)
        if not self.rooms[page_id]:
            self.rooms.pop(page_id, None)
        self.connection_users.pop(websocket, None)
        self.read_only_connections.discard(websocket)
        return self.connection_locks.pop(websocket, set())

    def has_active_editors(self, page_id: UUID) -> bool:
        """True if any non-read-only connection remains in the room. Used to
        decide whether a page's replay session should end — a lingering
        read-only share-link viewer must not keep a session "active" forever
        after every real collaborator has left."""
        return any(
            connection not in self.read_only_connections for connection in self.rooms.get(page_id, set())
        )

    async def broadcast(self, page_id: UUID, message: dict, *, exclude: WebSocket | None = None) -> None:
        for connection in list(self.rooms.get(page_id, set())):
            if connection is exclude:
                continue
            try:
                await connection.send_json(message)
            except RuntimeError:
                self.rooms[page_id].discard(connection)


manager = ConnectionManager()
