# Game rules on the game server

This page describes the rules the game server (`server/`) enforces, how they
differ from the printed rules, the REST payloads for each action, and how to
run the rule and simulation tests. The rules live in
`server/src/main/java/ca/hexanome04/splendorgame/model`, mostly in
`gameversions/orient/OrientGame.java` (turn flow, nobles, end of game),
`Card.java` (payment checks) and the classes under `action/actions/`.

## Game versions

The server registers four game services with the Lobby Service (LS). Each one
is a separate `GameVersions` value, and all of them take 2 to 4 players.

- `splendor_BASE_ORIENT`, shown as "Splendor Orient": the base game plus the
  Orient expansion. The target is 15 prestige points.
- `splendor_BASE_ORIENT_CITIES`, shown as "Splendor Cities": base, Orient and
  the Cities module, played without nobles as the Cities rulebook says.
- `splendor_BASE_ORIENT_CITIES_NOBLES`, shown as "Splendor Nobles and Cities":
  the same game with nobles dealt as in the base game. This is a house variant.
- `splendor_BASE_ORIENT_TRADE_ROUTES`, shown as "Splendor Trade Routes": base,
  Orient and the Trading Posts module. The target is 15 prestige points.

The LS refuses to register a display name that is contained in an already
registered one (`GameServers.java` checks `existing.contains(newName)`). So no
display name may be a substring of another: "Splendor Cities with Nobles"
would have been refused, because it contains "Splendor Cities".
`CitiesVariantsTest` checks every pair.

## Setup

The LS player order is the seat order, and the first seat always starts.

- **Gems.** Each of the five gem colours starts with 4 tokens for 2 players, 5
  for 3 players and 7 for 4 players. There are always 5 Gold tokens. The token
  names in the API are `White`, `Blue`, `Green`, `Red`, `Brown` (the black
  onyx gem), `Gold` and `Satchel` (a bonus type only, never a token).
- **Cards.** Each regular row (tiers 1 to 3) shows 4 cards. Each Orient row
  (tiers 1 to 3) shows 2 cards.
- **Nobles.** Players + 1 nobles are dealt, except in "Splendor Cities",
  which deals none.
- **Cities.** The Cities versions show 3 cities, whatever the player count.

With 2 players, the board has 4 tokens of each gem and 5 Gold, 3 nobles (none
in "Splendor Cities") and 3 cities in the Cities versions. Taking two gems of
one colour needs at least 4 of that colour in the pile, so with 2 players it is
only possible from a full pile. `FullGameSimulationTests` checks this setup for
2, 3 and 4 players in every version.

## A turn

A turn is one main action, then any follow-up actions that action caused. The
game state lists what the current player may do next in `curValidActions`. A
turn starts with `TAKE_TOKEN`, `BUY_CARD` and `RESERVE_CARD`. An action that is
not in `curValidActions` is refused. A refused action changes nothing, because
every action checks everything before it changes any state.

When no follow-up is left, the server runs the end-of-turn checks in this
order:

1. **Noble visit.** If the player qualifies for exactly one noble, on the board
   or among the nobles they reserved, it visits. If they qualify for several,
   they must pick one with `CHOOSE_NOBLE`. At most one noble visits per turn.
2. **Expansion checks.** Trading Posts unlocks the powers the player now
   qualifies for. Cities gives the player a city, or asks for `CHOOSE_CITY`
   when several qualify.
3. **Win check.** Points gained in steps 1 and 2 count in this check.

Then the turn passes to the next seat, or the game ends (see "End of the game").

A follow-up is only requested when it can be carried out, so no turn can get
stuck. For example, a reserve-noble card gives no `RESERVE_NOBLE` when no noble
is on the board, and a cascade with no card to take is skipped.

### Taking tokens

`TAKE_TOKEN` takes up to 3 gems of different colours, or 2 gems of one colour
from a pile of at least 4.

- Gold and Satchel cannot be taken. Gold comes only from reserving.
- Amounts must be whole numbers from 0 upward.
- A player may end the turn with at most 10 tokens. With `putBackTokens` they
  return tokens in the same action, but only down to exactly 10. Tokens just
  taken may be returned too.
- Trading Posts power 2 also allows 2 gems of one colour plus 1 gem of another
  colour.

### Buying a card

`BUY_CARD` buys a card from the board or one of the player's reserved cards.
The payment must be exact:

- In each colour, the gems offered may not exceed the cost left after the
  player's bonuses.
- Gold pays for any gems the offer leaves unpaid, and the Gold offered may not
  exceed that.
- Whatever is still unpaid is covered by the gold bonuses of the player's
  double gold cards. A double gold card holds two gold bonuses, and the whole
  card is discarded once either bonus is used.
- With Trading Posts power 3, each Gold token or gold bonus pays for two gems
  of one colour.

An overpayment is refused with "You offered more than this card costs after
your bonuses; pay the exact amount." A payment that falls short is refused
with "The tokens offered, together with your bonuses, do not cover this card's
cost."

A satchel card can only be bought by a player who already owns a card with a
gem bonus.

A sacrifice card (cost type Bonus) costs no tokens. Instead it discards cards
the player owns: two single-bonus cards of the colour, or one double-bonus
card. The server picks the cards. It discards satchel cards first, then the
choice that loses the fewest prestige points, and prefers two singles on a
tie. The card being bought is never discarded.

### Reserving a card

`RESERVE_CARD` takes a visible card into the player's hand, up to 3 reserved
cards, and gives one Gold if any is left.

A player who already holds 10 tokens may send `putBackToken`. They take the
Gold and return that token, which may be the Gold itself. Without
`putBackToken`, they reserve the card without taking Gold, which keeps old
clients working. `putBackToken` is refused when the player holds fewer than 10
tokens or no Gold is left.

### Follow-up actions

- `CASCADE_1` and `CASCADE_2` take a free visible card of tier 1 or tier 2,
  from the regular or the Orient row of that tier. A satchel card can only be
  chosen when the player owns a gem bonus card. The card taken can cause
  follow-ups of its own.
- `CHOOSE_SATCHEL_TOKEN` gives a satchel card the colour of a gem bonus the
  player already owns.
- `RESERVE_NOBLE` reserves a noble from the board. A reserved noble visits
  later, like any other noble, once the player qualifies.
- `CHOOSE_NOBLE` picks one noble when the player qualifies for several.
- `CHOOSE_CITY` picks one city when the player qualifies for several.
- `TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER` (Trading Posts power 1) takes one gem
  after a purchase. Leaving out `takeToken` skips it. At 10 tokens, the player
  must also return one token with `putBackToken`.

### Trading Posts powers

A power unlocks at the end of the turn in which the player first holds its
bonuses. Unlocking a power places one of the player's 5 coats of arms.

1. 3 Red and 1 White bonus: take one extra gem after each purchase.
2. 2 White bonuses: when taking 2 gems of one colour, also take 1 gem of
   another colour.
3. 3 Blue and 1 Brown bonus: Gold pays for two gems.
4. 5 Green bonuses and a noble: 5 prestige points, once.
5. 3 Brown bonuses: 1 prestige point for each coat of arms the player has
   placed, this power's own included. The total grows as later coats are
   placed and is never counted twice.

### Cities

At the end of a turn, a player without a city receives one if they meet all
three of its requirements:

- the listed bonuses;
- the prestige points;
- the "same colour" count: that many bonuses of a single gem colour that the
  city does not already list. Gold bonuses never count for this requirement.

A player holds at most one city.

## End of the game

The game always finishes the round, so every player has the same number of
turns. The server checks for a winner only when the last seat ends its turn.

- **Orient and Trading Posts.** Every player with at least 15 prestige points
  is a candidate.
- **Cities.** Every player holding a city is a candidate, whatever their
  points.

Among the candidates, the most prestige wins. A tie goes to the player with
the fewest development cards. Development cards are the ones the player owns
at the end, so discarded double gold cards and sacrificed cards do not count.
Players still tied share the win. Their names are listed in `winners`, in seat
order.

Once the game is over:

- The state has `gameOver: true` and `turnCounter: -10000`, and
  `curValidActions` is empty, so there is no current player.
- `GET .../actions` returns `[]`.
- Any further action gets a 400 with "The game is over."
- The server marks the state as changed, so long-polling clients wake up.
  Then it deletes the session from the LS. If that call fails, the server logs
  a warning and still answers 200.

## Deviations from the printed rules

- **Taking fewer gems.** A player may take fewer than 3 different gems, or none
  at all, which works as a pass. The printed rules expect 3 different gems
  unless the piles do not allow it. The server allows fewer so that a player
  can never be stuck.
- **No blind reserve.** A player cannot reserve the top card of a deck face
  down. Only visible cards can be reserved.
- **Reserving at 10 tokens.** Without `putBackToken`, a player at 10 tokens
  reserves without Gold. With it, the turn plays as in the printed rules.
- **Sacrifices.** The server picks which cards a sacrifice discards (see
  "Buying a card"). The printed rules let the player choose.
- **Trading Posts target.** The Trading Posts version ends at 15 points, like
  the base game. The printed Trading Posts module may use a higher target (17
  is often cited). Check the rulebook before changing it, because the target
  changes the game's balance.
- **Nobles with Cities.** "Splendor Nobles and Cities" is a house variant.
  The official Cities game is `splendor_BASE_ORIENT_CITIES`.
- **Starting player.** The first seat in the LS player order always starts.

## REST actions

A player sends an action with:

```
PUT /api/sessions/{sessionId}/players/{playerName}/actions/{ACTION}?access_token=...
```

The body is a JSON object. The token must belong to `playerName`, otherwise
the server answers 401.

- **Success.** 200 with an empty body. The new state comes through the
  long-poll `GET /api/sessions/{sessionId}`.
- **Refusal.** 400 with a readable message, in each of these cases:
  - the action is not in `curValidActions`;
  - it is not the player's turn;
  - the body is malformed, has a missing field, an unknown token name, or a
    negative or fractional amount;
  - the game rules refuse the move.
- **Server error.** 500 only for a real server bug.

`GET /api/sessions/{sessionId}/players/{playerName}/actions` lists the
current player's valid actions. It answers 400 for a player whose turn it is
not, and `[]` once the game is over.

The bodies, by action:

```
TAKE_TOKEN        {"takeTokens": {"Red": 1, "Blue": 1, "Green": 1},
                   "putBackTokens": {"White": 1}}            putBackTokens optional
BUY_CARD          {"cardId": "42", "tokens": {"Red": 2, "Gold": 1}}
RESERVE_CARD      {"cardId": "42", "putBackToken": "Gold"}   putBackToken optional
CASCADE_1         {"cardId": "17"}
CASCADE_2         {"cardId": "57"}
CHOOSE_SATCHEL_TOKEN  {"cardId": "<satchel card id>", "selected": "Blue"}
RESERVE_NOBLE     {"cardId": "<noble id>"}
CHOOSE_NOBLE      {"cardId": "<noble id>"}
CHOOSE_CITY       {"cityId": "<city id>"}
TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER  {"takeToken": "Red", "putBackToken": "Blue"}
                                       both optional
```

`BUY_CARD` needs `tokens`, even when it is empty (`{}`). Amounts must be whole
numbers.

## The game state long-poll

`GET /api/sessions/{sessionId}` returns the game state as JSON. With
`?hash=<MD5 of the state the client shows>` it is a long-poll. The MD5 is the
lower-case hex digest of the state's UTF-8 bytes.

- If the hash is missing or differs from the current state's, the server
  answers 200 with the state at once.
- Otherwise it holds the request. The next change of the game (an action or a
  restart) answers it with 200 and the new state. After `longpoll.timeout`
  (30 s by default) it answers 204 with "No update.".
- A held poll takes no thread. `GameStateWatcher` keeps the held Spring
  `DeferredResult`s of each game, and a change answers them. The simpoll
  library used before started a thread per held poll, and that thread slept
  until the timeout even after the client had gone. Session ids are public,
  so anyone could hold thousands of polls and exhaust the server's threads.
- At most `longpoll.maxHeldPerGame` polls (64 by default) are held per game.
  One more answers the oldest held poll with 204, as a timeout would, and the
  client behind it polls again. A flood of polls on one game therefore costs
  a bounded amount of memory. It pushes real players' polls out, but never
  refuses them.
- An unknown session gets 400.

`GameStateWatcherTest` covers the hash rules, a move that lands between the
hash comparison and the hold, the cap and the absence of threads.
`GameStateLongPollHttpTest` holds polls through the embedded Tomcat and checks
the 204 timeout, the thread count, and that polls of clients that went away
are dropped after the timeout.

## Reproducible deals

The Spring property `gs.shuffleSeed` seeds the shuffles of every new game. It
is empty by default, which means a random shuffle.

- Set it with `--gs.shuffleSeed=42` on the jar's command line, in
  `application.properties`, or through the `GS_SHUFFLESEED` environment
  variable (Spring's usual mapping).
- While it is set, every new game gets the same deal for the same version and
  player count. Use it for end-to-end tests, never for real games.
- A value that is not a whole number stops the server at startup.

The seed is not saved with a game.

## Running the tests

Run all server tests from the repository root. Checkstyle runs first and fails
the build on a violation.

```
mvn -q -f server/pom.xml test
```

The tests most relevant to the rules:

- **`RuleFixesTests`** covers each rule on this page with the small test card
  file in `server/src/test/resources`.
- **`ActionsTests`, `CardTest`, `CitiesTests` and `TradingPostsTests`** are the
  older rule tests.
- **`SplendorRestControllerHardeningTest`** covers malformed input, the 401
  and 400 cases, the game-over path with a failing LS, waking long-poll
  watchers, and concurrent actions on one session.
- **`CitiesVariantsTest`** covers the two Cities versions, their service names,
  saving and loading, and the display names.
- **`FullGameSimulationTests`** plays complete games with the real card files.
  It covers 2, 3 and 4 players in all four versions, with 6 seeds each by
  default. The moves come from `SimulationBot`, which works out the legal
  moves on its own instead of trusting the server's checks.

`FullGameSimulationTests` checks after every action that:

- the tokens of each colour add up;
- nobody holds more than 10 tokens or 3 reserved cards;
- the noble and city counts are right, and no card is in two places;
- bonuses and prestige match the cards each player owns.

It also saves and loads each game once mid-game. At the end of each game it
checks that the game ended, that every player had the same number of turns,
and that the winners are the ones the rules call for.

Run only the simulation, or a longer soak run with more seeds:

```
mvn -q -f server/pom.xml -Dtest=FullGameSimulationTests test
mvn -q -f server/pom.xml -Dtest=FullGameSimulationTests -Dsim.seeds=60 test
```

The soak run plays 720 games and takes about ten times as long as the default
run. A failure names the version,
the player count and the seed, and the same seed replays the same game.

Loading a save makes Gson set every field of the game reflectively. JDK 26
warns when such a field is final, and a later JDK will refuse, which would
break every load. So no field of a saved class may be final:

- On JDK 26 and later, the Maven profile `deny-final-field-mutation` switches
  itself on and runs the tests with `--illegal-final-field-mutation=deny`. A
  final field then fails the save and load tests at once.
- `SavedStateFieldsTest` walks the saved classes and fails on a final field,
  so older JDKs (CI runs JDK 17) catch it too.
