"""What the agent says back to the user.

The LLM is not tested here — prompts are not unit-testable. What *is* testable,
and what actually breaks a demo, is the layer underneath: that a failed API call
never turns into "saved it", that a rejected dish is reported as rejected, and
that the confirmations read like speech rather than JSON.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import MealLoggingAgent, user_id_from_room  # noqa: E402
from beet_client import BeetApiError, describe_day, describe_entry  # noqa: E402

ROTI_ENTRY = {
    "id": "6510f0f0f0f0f0f0f0f0f0f0",
    "foodId": "roti",
    "foodName": "Roti",
    "quantity": 2,
    "unit": "piece",
    "grams": 80,
    "macros": {"calories": 238, "protein": 9, "carbs": 46.4, "fat": 3},
    "mealType": "lunch",
}


class FakeClient:
    """Stands in for the API. Every method either returns or raises what the real one would."""

    def __init__(self, **behaviour):
        self.behaviour = behaviour
        self.calls: list[tuple] = []

    async def _run(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        outcome = self.behaviour.get(name)
        if isinstance(outcome, Exception):
            raise outcome
        if callable(outcome):
            return outcome(*args, **kwargs)
        return outcome

    async def resolve_food(self, query):
        return await self._run("resolve_food", query)

    async def log_meal(self, **kwargs):
        return await self._run("log_meal", **kwargs)

    async def list_meals(self, **kwargs):
        return await self._run("list_meals", **kwargs)

    async def update_meal(self, entry_id, **patch):
        return await self._run("update_meal", entry_id, **patch)

    async def delete_meal(self, entry_id):
        return await self._run("delete_meal", entry_id)


def agent_with(**behaviour) -> tuple[MealLoggingAgent, FakeClient]:
    client = FakeClient(**behaviour)
    return MealLoggingAgent(client), client


# --- phrasing -------------------------------------------------------------


def test_entries_are_described_as_speech_not_data():
    assert describe_entry(ROTI_ENTRY) == "2 pieces of Roti, 238 calories"
    one = {**ROTI_ENTRY, "quantity": 1, "unit": "katori", "foodName": "Dal Tadka"}
    assert describe_entry(one) == "1 katori of Dal Tadka, 238 calories"
    grams = {**ROTI_ENTRY, "quantity": 150, "unit": "gram"}
    assert describe_entry(grams) == "150g of Roti, 238 calories"


def test_day_summary_carries_ids_and_totals():
    text = describe_day(
        {"entries": [ROTI_ENTRY], "totals": {"calories": 238, "protein": 9, "carbs": 46.4, "fat": 3}}
    )
    assert ROTI_ENTRY["id"] in text
    assert "Day total: 238 calories" in text
    assert describe_day({"entries": [], "totals": {}}) == "Nothing is logged for today yet."


def test_room_name_carries_the_user():
    assert user_id_from_room("beet__asha__9f2a") == "asha"
    assert user_id_from_room("beet____9f2a") == "demo-user"
    assert user_id_from_room("some-other-room") == "demo-user"
    assert user_id_from_room("") == "demo-user"


# --- logging --------------------------------------------------------------


async def test_log_meal_confirms_with_calories():
    agent, client = agent_with(log_meal=ROTI_ENTRY)
    said = await agent.log_meal(None, food="roti", quantity=2, unit="pieces", spoken_as="two rotis")
    assert said == "Logged to lunch: 2 pieces of Roti, 238 calories."
    _, _, kwargs = client.calls[0]
    assert kwargs["spoken_as"] == "two rotis"


async def test_a_dish_outside_the_database_is_reported_as_not_logged():
    agent, _ = agent_with(
        log_meal=BeetApiError('"pizza" is not in the Beet food database, so it cannot be logged.', "unknown_food")
    )
    said = await agent.log_meal(None, food="pizza", quantity=1)
    assert said.startswith("Not logged.")
    assert "not in the Beet food database" in said


async def test_ambiguous_dish_becomes_a_question_not_a_guess():
    agent, _ = agent_with(
        log_meal=BeetApiError(
            "could be more than one dish",
            "ambiguous_food",
            {"candidates": [{"name": "Paneer Butter Masala"}, {"name": "Palak Paneer"}]},
        )
    )
    said = await agent.log_meal(None, food="paneer", quantity=1)
    assert "Not logged." in said
    assert "Paneer Butter Masala or Palak Paneer" in said
    assert "Ask the user" in said


async def test_a_bad_unit_comes_back_with_the_allowed_ones():
    agent, _ = agent_with(
        log_meal=BeetApiError(
            'Palak Paneer cannot be logged in "glass"',
            "invalid_unit",
            {"allowed": ["katori", "gram"]},
        )
    )
    said = await agent.log_meal(None, food="palak paneer", quantity=1, unit="glass")
    assert "Allowed units are: katori, gram." in said


async def test_an_unreachable_api_never_claims_success():
    agent, _ = agent_with(log_meal=BeetApiError("I can't reach the meal log right now, so I haven't saved that.", "unreachable"))
    said = await agent.log_meal(None, food="roti", quantity=1)
    assert "Logged" not in said
    assert "haven't saved" in said


# --- catalogue lookups ----------------------------------------------------


async def test_find_food_reports_the_units_a_dish_allows():
    agent, _ = agent_with(
        resolve_food={"status": "ok", "food": {"name": "Dal Tadka", "units": [{"name": "katori"}, {"name": "bowl"}]}}
    )
    said = await agent.find_food(None, name="dal")
    assert "Dal Tadka is in the database" in said
    assert "katori, bowl" in said


async def test_find_food_refuses_what_is_not_there():
    agent, _ = agent_with(resolve_food={"status": "unknown", "candidates": []})
    said = await agent.find_food(None, name="sushi")
    assert "cannot be logged" in said


# --- edit / delete --------------------------------------------------------


async def test_update_reads_back_the_new_amount():
    updated = {**ROTI_ENTRY, "quantity": 3, "grams": 120, "macros": {**ROTI_ENTRY["macros"], "calories": 356}}
    agent, client = agent_with(update_meal=updated)
    said = await agent.update_meal(None, entry_id=ROTI_ENTRY["id"], quantity=3)
    assert said == "Updated. It is now 3 pieces of Roti, 356 calories."
    entry_id, patch = client.calls[0][1][0], client.calls[0][2]
    assert entry_id == ROTI_ENTRY["id"]
    assert patch == {"quantity": 3, "unit": None, "mealType": None, "food": None}


async def test_a_stale_id_sends_the_agent_back_to_the_list():
    agent, _ = agent_with(update_meal=BeetApiError("no meal entry with id", "entry_not_found"))
    said = await agent.update_meal(None, entry_id="deadbeefdeadbeefdeadbeef", quantity=3)
    assert "list_todays_meals" in said


async def test_delete_names_what_it_removed():
    agent, _ = agent_with(delete_meal={"deleted": {"foodName": "Chai (with sugar)"}})
    said = await agent.delete_meal(None, entry_id=ROTI_ENTRY["id"])
    assert said == "Deleted Chai (with sugar) from the log."


async def test_delete_of_a_missing_entry_is_honest():
    agent, _ = agent_with(delete_meal=BeetApiError("no meal entry with id", "entry_not_found"))
    said = await agent.delete_meal(None, entry_id="deadbeefdeadbeefdeadbeef")
    assert "no such entry" in said.lower()


async def test_listing_passes_the_narrowing_filters_through():
    agent, client = agent_with(list_meals={"entries": [ROTI_ENTRY], "totals": ROTI_ENTRY["macros"]})
    await agent.list_todays_meals(None, food="chai", meal_type="breakfast")
    assert client.calls[0][2] == {"food": "chai", "meal_type": "breakfast"}


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
