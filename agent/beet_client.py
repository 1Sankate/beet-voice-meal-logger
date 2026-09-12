"""Thin async client for the Beet API.

The agent owns *conversation*; this module owns *transport*. Nothing here
decides what a valid meal is or what it weighs — that is the server's job, and
keeping it that way is what stops the LLM from inventing calories.
"""

from __future__ import annotations

import os
from typing import Any

import aiohttp

DEFAULT_BASE_URL = os.getenv("BEET_API_URL", "http://localhost:4000")


class BeetApiError(Exception):
    """A structured failure from the API, safe to read out loud."""

    def __init__(self, message: str, code: str = "error", payload: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.payload = payload or {}

    @property
    def candidates(self) -> list[dict[str, Any]]:
        return self.payload.get("candidates", [])

    @property
    def allowed_units(self) -> list[str]:
        return self.payload.get("allowed", [])


class BeetClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, user_id: str = "demo-user") -> None:
        self.base_url = base_url.rstrip("/")
        self.user_id = user_id
        self._session: aiohttp.ClientSession | None = None

    async def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10),
                raise_for_status=False,
            )
        return self._session

    async def aclose(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        session = await self._http()
        params = {"userId": self.user_id, **(kwargs.pop("params", None) or {})}
        params = {k: v for k, v in params.items() if v is not None}
        try:
            async with session.request(method, f"{self.base_url}{path}", params=params, **kwargs) as res:
                body = await res.json(content_type=None)
                if res.status >= 400:
                    err = (body or {}).get("error", {})
                    raise BeetApiError(
                        err.get("message", f"request failed with status {res.status}"),
                        err.get("code", "http_error"),
                        err,
                    )
                return body
        except aiohttp.ClientError as exc:
            raise BeetApiError(
                "I can't reach the meal log right now, so I haven't saved that.",
                "unreachable",
            ) from exc

    # --- catalogue -----------------------------------------------------
    async def resolve_food(self, query: str) -> dict[str, Any]:
        return await self._request("GET", "/api/foods/resolve", params={"q": query})

    # --- meal log ------------------------------------------------------
    async def log_meal(
        self,
        food: str,
        quantity: float,
        unit: str | None = None,
        meal_type: str | None = None,
        spoken_as: str = "",
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/api/meals",
            json={
                "food": food,
                "quantity": quantity,
                "unit": unit,
                "mealType": meal_type,
                "spokenAs": spoken_as,
                "source": "voice",
            },
        )

    async def list_meals(
        self,
        food: str | None = None,
        meal_type: str | None = None,
        date: str | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/api/meals",
            params={"food": food, "mealType": meal_type, "date": date},
        )

    async def update_meal(self, entry_id: str, **patch: Any) -> dict[str, Any]:
        payload = {k: v for k, v in patch.items() if v is not None}
        return await self._request("PATCH", f"/api/meals/{entry_id}", json=payload)

    async def delete_meal(self, entry_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/meals/{entry_id}")


# --- phrasing helpers: turn API rows into something speakable -------------


def describe_entry(entry: dict[str, Any]) -> str:
    """'2 pieces of Roti, 238 calories' — what the agent reads back."""
    qty = entry["quantity"]
    qty_text = str(int(qty)) if float(qty) == int(qty) else str(qty)
    unit = entry["unit"]
    if unit == "gram":
        portion = f"{qty_text}g of {entry['foodName']}"
    else:
        plural = unit if float(qty) == 1 else f"{unit}s"
        portion = f"{qty_text} {plural} of {entry['foodName']}"
    return f"{portion}, {entry['macros']['calories']} calories"


def describe_day(view: dict[str, Any]) -> str:
    entries = view.get("entries", [])
    if not entries:
        return "Nothing is logged for today yet."
    lines = [
        f"[{e['id']}] {e['mealType']}: {describe_entry(e)}"
        for e in entries
    ]
    totals = view["totals"]
    lines.append(
        f"Day total: {totals['calories']} calories, "
        f"{totals['protein']}g protein, {totals['carbs']}g carbs, {totals['fat']}g fat."
    )
    return "\n".join(lines)
