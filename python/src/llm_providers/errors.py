"""One error type, with the same closed ``kind`` the TypeScript library uses."""

from __future__ import annotations

from typing import Any, Optional

#: auth, rate_limit, schema_rejected, bad_request, server, timeout, aborted, network, parse
KINDS = frozenset(
    {"auth", "rate_limit", "schema_rejected", "bad_request", "server", "timeout", "aborted", "network", "parse"}
)


class LlmError(Exception):
    """A failed call.

    ``kind`` says what to do about it. ``status`` is the UPSTREAM provider's HTTP status when there
    was one; ``http_status`` is the service's own reply status (None when the service was never
    reached).
    """

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        provider: str = "service",
        model: str = "",
        status: Optional[int] = None,
        http_status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind if kind in KINDS else "server"
        self.message = message
        self.provider = provider
        self.model = model
        self.status = status
        self.http_status = http_status

    def __repr__(self) -> str:
        return f"LlmError(kind={self.kind!r}, provider={self.provider!r}, model={self.model!r}, message={self.message!r})"


def error_from_body(http_status: int, body: Any) -> LlmError:
    """The service's ``{"error": {kind, message, provider, model, status?}}`` back into an LlmError."""
    e = body.get("error") if isinstance(body, dict) else None
    if not isinstance(e, dict):
        return LlmError("server", f"service answered HTTP {http_status} without an error body", http_status=http_status)
    return LlmError(
        str(e.get("kind", "server")),
        str(e.get("message", "")),
        provider=str(e.get("provider", "service")),
        model=str(e.get("model", "")),
        status=e.get("status") if isinstance(e.get("status"), int) else None,
        http_status=http_status,
    )
