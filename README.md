# Beet — voice meal logger

Talk to it, and what you ate shows up on the page with the right nutrition attached.

```
"I had two rotis and a katori of dal for lunch."   -> two entries, 418 kcal
"Actually make that three rotis."                  -> same entry, now 356 kcal
"Remove the chai I logged this morning."           -> that one chai, not the 5pm one
```

- **Voice agent** — Python, [LiveKit Agents](https://docs.livekit.io/agents/) 1.8, speech + LLM through LiveKit Inference
- **API** — Node 20+, Express 4, Mongoose 8, MongoDB
- **Web** — React 18 + Vite, one page, updates live over server-sent events

---

## Run it from an empty machine

**You need:** [Node 20+](https://nodejs.org), [uv](https://docs.astral.sh/uv/getting-started/installation/) (installs Python for you), and a free [LiveKit Cloud](https://cloud.livekit.io) project. No MongoDB install, no credit card.

```bash
git clone <this repo> && cd beet-voice-meal-logger
cp .env.example .env            # then paste your LIVEKIT_URL / KEY / SECRET
npm run setup                   # installs server + web
```

Three terminals:

```bash
npm run dev:api     # http://localhost:4000  — API + Mongo
npm run dev:web     # http://localhost:5173  — the page
npm run dev:agent   # the LiveKit agent (uv installs Python 3.12 + deps on first run)
```

Open <http://localhost:5173>, click **Talk to Beet**, allow the mic, and start talking.

**Without the browser:** `cd agent && uv run python agent.py console` talks to the same agent from your terminal, using your machine's mic and speakers (it still needs the LiveKit keys — speech and the LLM are served through LiveKit Inference). The API and the page work with no LiveKit at all; the agent is just another API client.

### About the database

`MONGODB_URI` empty (the default) starts an embedded `mongod` with an on-disk data directory at `server/.data/mongo`, downloaded automatically on first run. Logs survive restarts. Point `MONGODB_URI` at Atlas or your own `mongod` for anything beyond a laptop demo — nothing else changes.

---

## How it is put together

```
   browser (React)                      LiveKit Cloud                  agent (Python)
 ┌──────────────────┐   mic audio    ┌────────────────┐  audio     ┌───────────────────┐
 │ Talk to Beet     │───────────────▶│   room         │───────────▶│ STT → LLM → TTS   │
 │ today's meals    │◀───────────────│ beet__<user>__ │◀───────────│ 5 function tools  │
 └───────┬──────────┘  agent audio   └────────────────┘            └─────────┬─────────┘
         │  GET /api/meals                                                   │ HTTP
         │  SSE /api/stream  ◀── every write announces itself ───┐           │
         ▼                                                       │           ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  Express API   routes → services/meals.js → Mongo (meal log)                      │
 │                          └── lib/catalogue.js ← data/foods.json (read-only)       │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

The agent never computes nutrition and never invents a dish. It parses speech into `(food, quantity, unit, meal)` and hands that to the API; the API resolves the food against `foods.json`, validates the unit, computes the grams and the macros, and writes the entry. The page reads the same API.

### Decisions worth calling out

**`foods.json` is loaded read-only, not seeded into Mongo.** It is reference data that ships with the code and is the stated source of truth, so it belongs in the repo, not in a mutable collection that can drift from it. Mongo stores only the meal log. Practical upside: the "a user can only log dishes that exist in this set" constraint has exactly one enforcement point — an entry can only be created via `resolveFood()`, and `resolveFood()` can only ever return a row from that file.

**Macros are computed server-side and frozen onto the entry.** The LLM is structurally incapable of logging a wrong calorie count, because it never sends one — and if it does, the server ignores it (there is a test for that). Storing the computed numbers rather than recomputing on read means a future correction to `foods.json` cannot silently rewrite last week's history; the entry keeps the `foodId` that produced it.

**Speech resolution lives in the API, not in the prompt.** `lib/catalogue.js` normalises, singularises and token-scores against ids, names and aliases, so "chapati", "two rotis", "a katori of daal", "uble ande" and "mix veg" all land on the right row without the model guessing. It returns three outcomes, and each is a different conversation:

| outcome | example | what the agent does |
|---|---|---|
| `ok` | "chapati" → Roti | logs it |
| `ambiguous` | "paneer" → two paneer dishes | asks which one |
| `unknown` | "pizza" | says Beet does not have it, logs nothing |

**Editing and deleting go list-first.** Entry ids are Mongo ObjectIds, and an LLM asked to remember one across turns will eventually make one up. So `GET /api/meals` takes `food` and `mealType` filters: "the chai I logged this morning" becomes `?food=chai&mealType=breakfast`, which returns one row with its real id, and *that* id is what gets deleted. The agent is instructed to list before every edit or delete, and a stale id comes back as a 404 telling it to list again.

**The page re-reads instead of patching.** Every write emits on an `EventEmitter` that feeds `GET /api/stream` (SSE). The page's only reaction to an event is to refetch the day, so what is on screen cannot drift from what is in the database. One-way traffic, ~20 lines, no websocket layer.

**The page survives the API going away.** The server sends a `ready` event on every stream connect, and the page refetches on it as well as on `meals` — so anything written while the page was disconnected shows up the moment it reconnects. In dev, the Vite proxy needed one line for this to work at all: when the API died, the proxy logged `ECONNRESET` but left the browser's `/api/stream` socket hanging open, so `EventSource` never errored, never reconnected, and the page went silently stale until a manual reload. `web/vite.config.js` now destroys the client socket on proxy error. Found by restarting the API with the page open and logging a meal during the gap; verified by repeating it with the fix (page caught up with no reload).

**Room names carry the user.** The token endpoint mints `beet__<userId>__<random>`; the agent parses the user out of the room name it was dispatched into. That is enough to scope the log per user without an auth system this assignment doesn't need. Every meal query is scoped by `userId` and there is a test that one user cannot delete another's entry.

### API

| | |
|---|---|
| `GET /api/foods` | the catalogue, for the page |
| `GET /api/foods/resolve?q=dal` | speech → dish: `ok` / `ambiguous` / `unknown` |
| `GET /api/meals?date=&food=&mealType=` | a day's entries plus totals |
| `POST /api/meals` | `{ food, quantity, unit, mealType, spokenAs }` → entry with computed macros |
| `PATCH /api/meals/:id` | any of quantity / unit / mealType / food; macros recomputed |
| `DELETE /api/meals/:id` | remove one entry |
| `GET /api/stream` | SSE, one event per write |
| `GET /api/livekit/token` | a join token for the browser |

Errors are always `{ error: { code, message, ...context } }`. The `message` is written to be read aloud, because the agent does exactly that: `"Palak Paneer cannot be logged in \"glass\""` with `allowed: ["katori","gram"]` attached.

### The agent's tools

`find_food` · `log_meal` · `list_todays_meals` · `update_meal` · `delete_meal` — each one an HTTP call, each returning a short spoken-English string. Tool failures return a sentence explaining what went wrong rather than raising, so the model can recover in-conversation ("Not logged. 'paneer' could be Paneer Butter Masala or Palak Paneer. Ask the user which one.") instead of apologising vaguely.

---

## Tests

```bash
npm test            # 34 API + catalogue tests (node:test, in-memory Mongo)
npm run test:agent  # 18 agent tests (pytest); 3 integration ones skip unless the API is up
```

What I chose to test, and why:

- **`server/tests/catalogue.test.js`** — the resolver, the unit table and the macro arithmetic. A wrong answer here is a wrong calorie count on a nutrition-care product, and it is pure logic, so it gets the densest tests: 14 spoken phrasings, plurals and aliases, the ambiguity split, per-dish unit rejection, and hand-checked macro values (2 rotis = 80 g = 238 kcal).
- **`server/tests/meals-api.test.js`** — the whole HTTP surface against a real Mongo, including the things that make a demo embarrassing: client-sent macros being ignored, a rejected edit leaving the entry untouched, days not bleeding into each other, one user not seeing another's log, malformed ids being 404 rather than 500.
- **`server/tests/conversation.test.js`** — the three assignment flows driven through exactly the calls the agent makes, asserting on *what the page would show* after each turn. This is the test that would actually catch a broken demo.
- **`agent/tests/test_tools.py`** — the tool layer against a stubbed API. The point is that a failure never becomes "saved it": unreachable API, unknown dish, ambiguous dish and bad unit each have a test on the exact sentence the user hears.
- **`agent/tests/test_live_api.py`** — the same tools against a running backend, proving the agent-to-database path end to end. Skipped automatically when the API is not up.

Verified by hand in a browser, because these are about the running system rather than any one function:

| did | saw |
|---|---|
| logged 2 rotis + 1 katori dal + 1 cup chai via the API with the page open | all three appeared without reload, grouped by meal, 523 kcal |
| edited roti to 3 | `3 × piece (120 g)`, 356 kcal |
| deleted chai | gone, total 536 kcal |
| killed and restarted the API, logged a meal as soon as it was up | page reconnected and showed it with no reload |
| restarted the API process, re-read the log | same entries, same ids — the on-disk embedded Mongo persists |
| clicked "Talk to Beet" with no LiveKit keys | clear message naming the three env vars, not a crash |

What I deliberately did not test: the prompt itself, and LiveKit's audio pipeline. Prompt behaviour is not stable enough to assert on in a unit test, and testing LiveKit would be testing LiveKit. The seam I *can* pin down — every tool call and everything downstream of it — is covered.

---

## What's incomplete, and what I'd do differently

- **No auth.** Everything is `demo-user` unless a `userId` is passed. The scoping is real (queries and deletes are per-user, with a test), the identity is not — a real deployment needs the user id to come from a verified token, not from a room name.
- **Timezone is the server's local time.** "Today" and "this morning" are computed with local `Date` boundaries, which is correct when the server runs in the user's timezone and wrong otherwise. The fix is storing a timezone per user and doing day maths with `Intl` — a real change, not a config flag, so I left it honest rather than half-done.
- **Relative time is coarse.** "Yesterday's dinner" is not parsed; the agent only edits and deletes within today. `GET /api/meals?date=` already supports any day, so this is a prompt-and-tool gap, not a data one.
- **Ambiguous *entries* still need a human question.** If you logged the same dish twice in one meal and say "remove the dal", the agent asks which one rather than picking. Correct, but clunkier than a product would ship.
- **The quote under an edited entry is stale.** `spokenAs` records the words that *created* the entry, and `update_meal` doesn't send new wording — so after "make that three rotis" the page shows `3 × piece` under the quote "two rotis". The numbers are right; the quote is history. Either update it on edit or label it "originally said".
- **The live-sync fix is dev-only.** It lives in the Vite proxy. A production build served behind a different proxy (nginx, a PaaS router) needs the same "close the client when upstream dies" behaviour checked there.
- **Deletes are hard deletes.** A soft-delete flag would let "undo that" work, which is an obvious next thing a voice product wants.
- **One agent, one room.** No load testing, no multi-region, no reconnect story beyond LiveKit's own.
- **The embedded mongod is a convenience, not a deployment.** It exists so this repo runs on a clean machine in one command. Anything real sets `MONGODB_URI`.
- **Unit conversion is exactly what `foods.json` allows.** "Half a plate of biryani" works (quantity 0.5); "a small bowl" does not, because there is no such unit in the data. I chose to reject rather than to approximate — this is a nutrition product, and a quiet guess is worse than a question.

---

## Repo layout

```
data/foods.json        source of truth for nutrition, unmodified
server/                Express + Mongoose API
  src/lib/             catalogue: resolution, units, macro math
  src/services/        meal-log business rules (the only writer)
  src/routes/          transport
  tests/               34 tests
web/                   React + Vite page, live over SSE
agent/                 LiveKit voice agent + its tools
```
