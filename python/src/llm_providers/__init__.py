"""Python client for the llm-providers service. See docs/SERVICE.md in the repository."""

from .client import DEFAULT_URL, AsyncClient, Client
from .errors import LlmError
from .results import CompletionResult, SystemOneResult, ToolCall, Usage

__all__ = [
    "AsyncClient",
    "Client",
    "CompletionResult",
    "DEFAULT_URL",
    "LlmError",
    "SystemOneResult",
    "ToolCall",
    "Usage",
]
__version__ = "0.2.0"
