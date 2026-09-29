# llm-providers (Python)

The Python client for `llm-providers serve`, the local service that puts Anthropic, OpenRouter,
OpenAI-compatible servers (vLLM), Ollama and System One (Jev, CLM) behind one call. The service
holds the API keys; this client never does.

```bash
npx llm-providers serve    # in the llm-providers repo, or wherever it is installed
pip install "git+https://github.com/Codewiz2898/llm-providers.git#subdirectory=python"
```

```python
from llm_providers import Client

with Client() as llm:  # http://127.0.0.1:8787
    r = llm.complete(
        model="ollama:qwen3:8b",
        messages=[{"role": "user", "content": "Is water wet? Answer as JSON."}],
        max_tokens=200,
        schema={"name": "verdict", "schema": {"type": "object", "properties": {"answer": {"type": "string"}}}},
    )
    print(r.json, r.finish, r.warnings, r.usage)
```

`AsyncClient` has the same surface for asyncio. Errors raise `LlmError`, whose `kind` is one of
`auth`, `rate_limit`, `schema_rejected`, `bad_request`, `server`, `timeout`, `aborted`, `network`,
`parse`, `unauthorized`, `forbidden` or `budget_exceeded`. `budget_exceeded` means the app has spent
its daily budget on the gateway: do not retry before local midnight. The design is in `docs/SERVICE.md` at the repository root.
