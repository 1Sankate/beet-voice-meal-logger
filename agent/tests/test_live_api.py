"""Integration: the agent's tools against a real running backend.

Skipped automatically when the API is not up, so `pytest` still passes on a
machine with nothing running. Start the server and run it to prove the whole
agent-to-database path — the only part the mocked tests cannot prove.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import aiohttp
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import MealLoggingAgent  # noqa: E402
from beet_client import BeetClient  # noqa: E402

API = os.getenv("BEET_API_URL", "http://localhost:4000")


async def api_is_up() -> bool:
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as s:
            async with s.get(f"{API}/api/health") as res:
                return res.status == 200
    except Exception:
        return False


@pytest.fixture
async def agent():
    if not await api_is_up():
        pytest.skip(f"Beet API not running at {API}")
    client = BeetClient(base_url=API, user_id=f"pytest-{uuid.uuid4().hex[:8]}")
    try:
        yield MealLoggingAgent(client)
    finally:
        await client.aclose()


async def test_log_edit_delete_round_trip(agent):
    logged = await agent.log_meal(None, food="two rotis", quantity=2, unit="pieces", meal_type="lunch", spoken_as="two rotis")
    assert logged == "Logged to lunch: 2 pieces of Roti, 238 calories."

    listed = await agent.list_todays_meals(None, food="roti")
    entry_id = listed.split("[", 1)[1].split("]", 1)[0]
    assert len(entry_id) == 24

    updated = await agent.update_meal(None, entry_id=entry_id, quantity=3)
    assert updated == "Updated. It is now 3 pieces of Roti, 356 calories."

    assert "Deleted Roti" in await agent.delete_meal(None, entry_id=entry_id)
    assert await agent.list_todays_meals(None) == "Nothing is logged for today yet."


async def test_the_catalogue_constraint_holds_over_http(agent):
    assert "cannot be logged" in await agent.find_food(None, name="pizza")
    assert "Not logged." in await agent.log_meal(None, food="pizza", quantity=1)
    assert await agent.list_todays_meals(None) == "Nothing is logged for today yet."


async def test_ambiguity_survives_the_round_trip(agent):
    said = await agent.log_meal(None, food="paneer", quantity=1)
    assert "Ask the user which one" in said
