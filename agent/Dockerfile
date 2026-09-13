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

# Bake in model files (local turn-detector fallback) so cold starts don't download them.
RUN uv run --no-dev python agent.py download-files

CMD ["uv", "run", "--no-dev", "python", "agent.py", "start"]
