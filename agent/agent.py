"""Beet's meal-logging voice agent.

Design in one line: the LLM is a *parser and a conversationalist*, never a
source of nutrition truth. Every tool below is a call into the Beet API, which
owns the catalogue, the unit table and the macro math. If the API says a dish
does not exist, the agent has no way to log it anyway.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    TurnHandlingOptions,
    cli,
    inference,
)
from livekit.agents.llm import function_tool

from beet_client import BeetApiError, BeetClient, describe_day, describe_entry

load_dotenv()
load_dotenv(".env.local", override=True)

logger = logging.getLogger("beet-agent")

STT_KEYTERMS = [
    "katori", "roti", "chapati", "phulka", "dal", "daal", "tadka", "chawal", "rajma",
    "chole", "paneer", "palak paneer", "paneer butter masala", "dahi", "doodh", "chai",
    "idli", "dosa", "sambar", "chutney", "poha", "upma", "aloo paratha", "paratha",
    "anda", "omelette", "tandoori chicken", "machli", "sabzi", "bhindi", "khichdi",
    "biryani", "kela", "seb", "badam",
]

INSTRUCTIONS = """
You are Beet's meal-logging assistant. You talk to the user by voice, so keep
every reply to one or two short spoken sentences. Never use markdown, emoji,
bullet points, or symbols. Say numbers the way a person would.

Your only job is to log, edit and delete meals in the user's food diary.

Rules you must follow:
- Only dishes in the Beet food database can be logged. If the user names
  something else, say Beet does not have that dish yet and do not log anything.
  Never substitute a different dish without asking.
- Log each dish as its own entry. "Two rotis and a katori of dal" is two
  separate log_meal calls.
- If the user does not say a quantity, assume one. If they do not say a unit,
  leave it out and let the database pick the normal serving.
- Log a dish as soon as the user has named it. Do not hold it back waiting for
  more detail, so that a later correction has an entry to change.
- A correction to something already logged ("actually make that three rotis",
  "no, it was dinner") is an edit: call update_meal on that entry. Never call
  log_meal again for it, because that creates a duplicate.
- To edit or delete, first call list_todays_meals to find the entry, then use
  the exact entry id it returns. Never invent an id and never read an id aloud.
- Before deleting more than one entry at once, say which ones and ask the user
  to confirm.
- If the user is vague about which entry they mean and there is more than one
  match, ask a short question instead of guessing.
- After a successful log, edit or delete, confirm in one short sentence and
  include the calories. Do not list the whole day unless asked.
- If a tool tells you something failed, say what went wrong in plain words.
  Never claim you saved something that was not saved.
"""


class MealLoggingAgent(Agent):
    def __init__(self, client: BeetClient) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self.client = client

    async def on_enter(self) -> None:
        self.session.generate_reply(
            instructions=(
                "Greet the user in one short sentence and invite them to tell you what they ate."
            )
        )

    # --- catalogue ----------------------------------------------------

    @function_tool
    async def find_food(self, context: RunContext, name: str) -> str:
        """Check whether a dish exists in the Beet food database and in which units it can be logged.

        Use this when you are unsure a dish exists, or when the user's wording could
        mean more than one dish.

        Args:
            name: The dish as the user said it, for example "dal" or "paneer".
        """
        try:
            result = await self.client.resolve_food(name)
        except BeetApiError as exc:
            return exc.message

        if result["status"] == "ok":
            food = result["food"]
            units = ", ".join(u["name"] for u in food["units"])
            return f"{food['name']} is in the database. It can be logged in: {units}."
        if result["status"] == "ambiguous":
            names = " or ".join(c["name"] for c in result["candidates"])
            return f"That could be {names}. Ask the user which one they mean."
        return f"There is no dish matching '{name}' in the Beet database. It cannot be logged."

    # --- log ----------------------------------------------------------

    @function_tool
    async def log_meal(
        self,
        context: RunContext,
        food: str,
        quantity: float = 1,
        unit: Optional[str] = None,
        meal_type: Optional[str] = None,
        spoken_as: str = "",
    ) -> str:
        """Add one dish to the user's meal log.

        Call this once per dish. The database computes the weight and the macros.

        Args:
            food: The dish name as the user said it, for example "roti" or "dal".
            quantity: How many units, for example 2. Defaults to 1.
            unit: The household unit the user said, such as piece, katori, bowl,
                glass, cup, plate, tablespoon, handful or gram. Leave empty if the
                user did not say one.
            meal_type: breakfast, lunch, dinner or snack, if the user said which
                meal it was. Leave empty to use the current time of day.
            spoken_as: The user's own words for this item, for example "two rotis".
        """
        try:
            entry = await self.client.log_meal(
                food=food,
                quantity=quantity,
                unit=unit,
                meal_type=meal_type,
                spoken_as=spoken_as or food,
            )
        except BeetApiError as exc:
            if exc.code == "ambiguous_food":
                names = " or ".join(c["name"] for c in exc.candidates)
                return f"Not logged. '{food}' could be {names}. Ask the user which one."
            if exc.code == "invalid_unit":
                units = ", ".join(exc.allowed_units)
                return f"Not logged. {exc.message}. Allowed units are: {units}."
            if exc.code == "unknown_food":
                return f"Not logged. {exc.message} Tell the user Beet does not have that dish."
            return f"Not logged. {exc.message}"

        return f"Logged to {entry['mealType']}: {describe_entry(entry)}."

    # --- read ---------------------------------------------------------

    @function_tool
    async def list_todays_meals(
        self,
        context: RunContext,
        food: Optional[str] = None,
        meal_type: Optional[str] = None,
    ) -> str:
        """List what the user has logged today, with the entry id needed to edit or delete.

        Call this before any edit or delete. Narrow it with food and meal_type when
        the user refers to a specific item, such as "the chai from this morning".

        Args:
            food: Only show this dish, for example "chai".
            meal_type: Only show this meal: breakfast, lunch, dinner or snack.
        """
        try:
            view = await self.client.list_meals(food=food, meal_type=meal_type)
        except BeetApiError as exc:
            return exc.message
        return describe_day(view)

    # --- edit / delete ------------------------------------------------

    @function_tool
    async def update_meal(
        self,
        context: RunContext,
        entry_id: str,
        quantity: Optional[float] = None,
        unit: Optional[str] = None,
        meal_type: Optional[str] = None,
        food: Optional[str] = None,
    ) -> str:
        """Change an entry that is already logged. The macros are recalculated.

        Get entry_id from list_todays_meals first. Only pass the fields that change.

        Args:
            entry_id: The id from list_todays_meals.
            quantity: The corrected number of units.
            unit: The corrected unit.
            meal_type: The corrected meal: breakfast, lunch, dinner or snack.
            food: The corrected dish, if the user named the wrong dish.
        """
        try:
            entry = await self.client.update_meal(
                entry_id,
                quantity=quantity,
                unit=unit,
                mealType=meal_type,
                food=food,
            )
        except BeetApiError as exc:
            if exc.code == "entry_not_found":
                return "No entry with that id. Call list_todays_meals again and use an id from the result."
            if exc.code == "invalid_unit":
                return f"Not changed. {exc.message}. Allowed units are: {', '.join(exc.allowed_units)}."
            return f"Not changed. {exc.message}"
        return f"Updated. It is now {describe_entry(entry)}."

    @function_tool
    async def delete_meal(self, context: RunContext, entry_id: str) -> str:
        """Remove an entry from the log.

        Get entry_id from list_todays_meals first.

        Args:
            entry_id: The id from list_todays_meals.
        """
        try:
            result = await self.client.delete_meal(entry_id)
        except BeetApiError as exc:
            if exc.code == "entry_not_found":
                return "There is no such entry. Call list_todays_meals again to see what is there."
            return f"Not deleted. {exc.message}"
        return f"Deleted {result['deleted']['foodName']} from the log."


def user_id_from_room(room_name: str) -> str:
    """Rooms are named beet__<userId>__<session> by the token endpoint."""
    parts = (room_name or "").split("__")
    return parts[1] if len(parts) >= 2 and parts[0] == "beet" and parts[1] else "demo-user"


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    user_id = user_id_from_room(ctx.room.name)
    ctx.log_context_fields = {"room": ctx.room.name, "user": user_id}

    client = BeetClient(user_id=user_id)
    ctx.add_shutdown_callback(client.aclose)

    session = AgentSession(
        stt=inference.STT(
            os.getenv("BEET_STT_MODEL", "deepgram/nova-3"),
            language="multi",
            # Hindi food words and household units were being heard as
            # "kandori", "Taal", "Sweet Chabadis"; key-term prompting biases
            # recognition toward them. ponytail: hand-picked from foods.json,
            # regenerate if the catalogue grows.
            extra_kwargs={"keyterm": STT_KEYTERMS},
        ),
        llm=inference.LLM(os.getenv("BEET_LLM_MODEL", "openai/gpt-4.1-mini")),
        tts=inference.TTS(os.getenv("BEET_TTS_MODEL", "cartesia/sonic-3")),
        turn_handling=TurnHandlingOptions(turn_detection=inference.TurnDetector()),
        # "two rotis and a katori of dal" is two logs plus a confirmation, so the
        # default of 3 tool steps per turn is not enough headroom.
        max_tool_steps=8,
        tts_text_transforms=["filter_emoji", "filter_markdown"],
    )

    await session.start(agent=MealLoggingAgent(client), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
