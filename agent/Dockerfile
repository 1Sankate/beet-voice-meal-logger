# Image for LiveKit Cloud (`lk agent create` / `lk agent deploy` from this folder).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# Dependencies first so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY . .
RUN uv sync --locked --no-dev

# No download-files step: models run through LiveKit Inference and the agent
# uses no livekit.plugins packages, so there is nothing to pre-fetch.
CMD ["uv", "run", "--no-dev", "python", "agent.py", "start"]
