"""SSRF protection for outbound webhook delivery.

Webhook targets are supplied by channel admins, so a naive request could be
pointed at ``localhost``, private-network services, or the cloud metadata
endpoint (169.254.169.254). Block any target that resolves to a non-public
address before we ever connect to it.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def _ip_is_internal(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True  # un-parseable → treat as unsafe
    # Covers loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7),
    # link-local incl. the 169.254.169.254 cloud-metadata range, plus reserved/
    # multicast/unspecified.
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def host_is_obviously_internal(host: str) -> bool:
    """Cheap literal check (no DNS) for fast rejection at creation time."""
    host = host.strip().lower().strip("[]")
    if host in {"localhost", "localhost.localdomain", ""}:
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False  # a hostname — can't judge without DNS, defer to delivery
    return _ip_is_internal(host)


def webhook_url_is_safe(url: str) -> bool:
    """Authoritative pre-delivery check: resolve the host and reject if ANY
    resolved address is internal. Run this in a worker thread (DNS is blocking)."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = parsed.hostname
    if not host:
        return False
    # IP literal → check directly.
    try:
        ipaddress.ip_address(host)
        return not _ip_is_internal(host)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(
            host,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror:
        return False
    return all(not _ip_is_internal(info[4][0]) for info in infos)
