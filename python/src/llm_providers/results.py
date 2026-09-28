"""What a call returns, as frozen dataclasses with Python names."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    args: Dict[str, Any]


@dataclass(frozen=True)
class Usage:
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cache_read_tokens: Optional[int] = None
    cache_write_tokens: Optional[int] = None
    #: When the provider reports it (OpenRouter does).
    cost_usd: Optional[float] = None


@dataclass(frozen=True)
class CompletionResult:
    text: str
    #: The parsed object, when a schema was given and the text parsed.
    json: Any
    tool_calls: List[ToolCall]
    #: The assistant turn, ready to append to ``messages`` when continuing (keeps ``raw``).
    message: Dict[str, Any]
    #: "stop" | "length" | "tool_calls" | "refusal" | "other"
    finish: str
    usage: Usage
    provider: str
    model: str
    ms: int
    #: schema_relaxed, reasoning_fallback, truncated, empty, json_unparsed, tool_args_unparsed
    warnings: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class SystemOneResult:
    #: question id -> {type, choice | noul | score, confidence?, probabilities?}
    answers: Dict[str, Dict[str, Any]]
    ms: int
    cost_usd: Optional[float] = None
