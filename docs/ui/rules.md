# Board rule modules

The board redesign keeps every game rule the client needs in small, pure ES
modules under `client/src/scripts/sp/`. They read the Game Service state JSON
and return plain data. They never touch the DOM, the network or storage, so
the same code runs in the browser (bundled by Astro) and under `node --test`.

The modules are:

- `rules-common.js`: shared constants, state lookups, the board phase and seat
  colours.
- `rules-take.js`: taking gems on the gem rail, returning gems above 10, Pass.
- `rules-pay.js`: payment, affordability, reserving and sacrifices.
- `progress.js`: how far a player is from a noble, a city or a Trading Posts
  power.
- `errors.js`: player copy for Game Service error messages.

They mirror the server model in `server/src/main/java/ca/hexanome04/splendorgame/model`
(the rules themselves are described in [the game rules page](../game-rules.md)).
Where the client is deliberately stricter than the server, this page says so.

## Conventions

- **State.** The state is exactly what `GET /api/sessions/{id}` returns. Field
  names are the Java field names, and a field that is null on the server is
  absent from the JSON. `tests/fixtures/states.mjs` builds such states.
- **Missing fields.** A missing field counts as 0, false or empty. A token map
  may omit keys, and a value that is not a finite number counts as 0.
- **Colours.** Colour names are the server's TokenType names: `White`, `Blue`,
  `Green`, `Red`, `Brown`, `Gold` and `Satchel`. `GEMS` is the display order
  (White, Blue, Green, Red, Brown). `SERVER_GEM_ORDER` is the server's enum
  order, used only where the order of the server's own loops matters.
  `TOKEN_KEYS` is the gems plus Gold. Satchel is a bonus type and never a token.
- **Players.** A function that receives the state accepts either a player
  object or a player name for its player argument.
- **Payloads.** The payload builders always send all six `TOKEN_KEYS` in token
  maps (Satchel left out), so request bodies keep one shape.

## rules-common.js

- `amount(map, key)` and `total(map)` read token maps.
- `goldValue(player)` is 2 once the Trading Posts power
  `goldTokenWorthTwoTokens` is unlocked, otherwise 1. A gold bonus from a
  double-gold card is worth the same as a gold token.
- `ownsGemBonusCard(player)` is the Satchel prerequisite: the player owns a
  development card whose bonus is a gem colour.
- `hasDoublePlusOne(player)` tells whether Trading Posts power 2 is unlocked.
- `currentPlayer(state)`, `findPlayer(state, name)`, `resolvePlayer`,
  `seatIndex`.
- `phaseOf(state, me)` returns the board phase for the viewer `me`, checked in
  this order: `loading` (no state), `over` (`gameOver`), `spectator` (not
  seated), `mine` (your seat and a main action is pending), `followup` (your
  seat and `curValidActions[0]` is a follow-up), `other`. Game over comes
  before spectator on purpose, so a spectator of a finished game sees the
  result instead of "Watching".
- `followUpOf(state)` is the pending follow-up action or null.
- `seatColour(state, name)` and `seatColours(state)`: a player's own colour is
  used when it is a valid 6-digit hex (the server sends `1E90FF`, without the
  '#') that no earlier seat already shows. Otherwise the seat gets the palette
  colour of its index (#3b82f6, #ef4444, #22c55e, #a855f7), or the first
  palette colour still free. Colours come back in lower case with the '#'.
  The fixtures give every player `1E90FF`, so seat 0 keeps it and the other
  seats fall back to the palette. A name that is not seated gives null.
- `marketCards(state)`, `locateCard(state, id)` (market, someone's reserve, or
  someone's tableau, with the deck or owner) and `cardById(state, id)`.
- `cardTags(card)` names the Orient effects: cascade, reserve-noble, satchel,
  double-gold and sacrifice.
- `cascadeChoices(state, player, tier)` mirrors `OrientGame.getCascadeChoices`:
  the visible cards of that tier, regular row first, then the Orient row,
  without unassigned Satchel cards when the player owns no gem-bonus card.
- `satchelColours(player)` mirrors `ChooseTokenTypeAction`: the gem colours of
  the player's own cards. An already assigned satchel counts as its colour.
  `unassignedSatchel(player)` is the first card still waiting for a colour,
  which is the `cardId` the satchel follow-up sends.

## rules-take.js

A **pick** map holds the gems tapped so far (1 or 2 per colour). A **return**
map holds the tokens handed back to end on exactly 10, and may include Gold.

- `pickTransition(state, player, picks, colour)` is what a tap on a bank pile
  does. It returns `{picks, changed, shake, code, hint}`:
  - An unpicked colour is added as a single when no double is picked and
    fewer than 3 singles are. With power 2 it is also added as the one single
    next to a double. Otherwise the tap is rejected with a shake and one of
    the hints "Max 3 different colours", "2 of one colour is a whole turn" or
    "With 2 of a colour you may add 1 more".
  - A colour picked once becomes a double when it is the only pick and its
    bank pile holds at least 4. Otherwise the tap removes it.
  - A colour picked twice is removed.
  - Gold is never pickable ("Gold comes only from reserving a card"), and
    neither is an empty pile.
  - One case needs reconciling two parts of the design. Section 5.3 says a
    second tap on a lone single from a pile of 3 removes it, and the WP-DOCK
    acceptance says that tap shakes with a hint. The function does both: it
    removes the pick, sets `shake`, and gives the hint "Taking 2 Red needs a
    pile of 4" (code `double-needs-4`). The dock can drop the shake if it
    feels wrong in use.
- `takeHint(state, player, picks)` is the live hint: "Tap Red again to take 2"
  for a lone single whose pile holds at least 4, "Pick 2 more colours" or
  "Pick 1 more colour" while singles are missing, "You may add 1 more colour"
  for a double with power 2, otherwise empty.
- `isLegalTake(state, player, take)` accepts only gem colours, whole amounts
  of 0 to 2 that the bank holds, and one of these shapes:
  - exactly `min(3, colours the bank has)` distinct singles and no double;
  - one double from a pile of at least 4;
  - with power 2, one double plus one single.

  The server also accepts 1 or 2 singles when 3 colours are available. The
  client refuses them on purpose, because taking fewer gems than allowed is
  almost always a mistake. An empty take is not a take here: it is the Pass,
  handled separately.
- `excessAfter(player, take)` is `max(0, held + taken - 10)`.
- `validReturn(player, take, returns)` requires whole, non-negative amounts of
  gems or Gold, each at most held plus taken of that colour (gems just taken
  may go straight back), and a total of exactly the excess. The server refuses
  ending above 10 and also refuses returning while ending below 10, so a
  return must land exactly on 10.
- `returnTransition(player, take, returns, colour)` is what a tap on your own
  holdings does while returning: one more return of that colour, up to held
  plus taken and up to the excess. A colour at its cap clears instead. When
  the returns already make up the excess, tapping a returned colour clears it
  and any other tap is rejected with a hint. The result carries `remaining`.
- `buildTakePayload(take, returns)` gives
  `{takeTokens: {White, Blue, Green, Red, Brown, Gold: 0}, putBackTokens: {White, Blue, Green, Red, Brown, Gold}}`
  with every key present. `putBackTokens` is always sent although the server
  treats it as optional.
- `buildPassPayload()` gives `{takeTokens: {}, putBackTokens: {}}`, which the
  server accepts as a turn without a take.
- `legalTakeExists(state)` is true when any gem colour is in the bank. Some
  take is then always legal, because tokens over 10 can always be returned,
  even the ones just taken.
- `legalMoveExists(state, me)` is true when the player has a legal take, a
  card on the market or in their reserve they can pay for, or a reserve
  (fewer than 3 reserved and a card on the market). Only main actions listed
  in `curValidActions` count, so it is meaningful during phase `mine`. The
  "No move possible · Pass" button shows only when it is false.

## rules-pay.js

- `stillOwed(card, player)` is `max(0, cost - bonus)` for every gem, and
  `costRows(card, player)` gives one breakdown row per cost colour:
  `{colour, cost, bonus, owed, have, short}`.
- `checkPayment(card, player, offered)` mirrors `Card.checkPayment` line for
  line and returns `{ok, code, ...}`, where `code` is the server's ActionResult
  name (`VALID_ACTION` when ok). It accepts exact payments only:
  - negative amounts, a Satchel token, unknown keys or fractional amounts give
    `INVALID_TOKENS_GIVEN` (the last two are refused by the server's JSON
    decoder with its own message);
  - offering a token the player lacks gives `NOT_ENOUGH_TOKENS_IN_INVENTORY`;
  - a sacrifice card refuses any token (`PAYMENT_TOO_HIGH`) and needs the
    bonuses (`NOT_ENOUGH_BONUSES`);
  - for each gem, paying more than the owed amount gives `PAYMENT_TOO_HIGH`,
    and `goldNeeded` adds `ceil((owed - paid) / goldValue)`;
  - offering more gold than `goldNeeded` gives `PAYMENT_TOO_HIGH`;
  - whatever gold is still needed comes from gold bonuses, and needing more
    than the player owns gives `PAYMENT_TOO_LOW`.

  It adds what the payment editor needs: `colour` (the first over-paid colour,
  or Gold), `shortBy` (gems still missing when too low), and for an accepted
  payment `goldBonusesUsed`, `goldCardsToDiscard`, `goldBonusesToRemove` and
  `goldBonusesWasted`. A double-gold card is discarded whole as soon as one of
  its two bonuses is used. It does not check the Satchel prerequisite, which
  the server checks in `BuyCardAction` first (see `satchelBlocked`).
- `autoPayment(card, player, {preferGoldCards})` builds the payment the card
  sheet fills in, per colour: `need = max(0, cost - bonus)`,
  `pay = min(need, tokens)`, `deficit = need - pay`, and
  `goldNeeded = Σ ceil(deficit / goldValue)`. Gold is rounded per colour, never
  in aggregate: with gold worth 2, a deficit of 1 Red and 1 Blue needs 2 gold.
  On top of that:
  - With gold worth 2, a colour with an odd deficit pays one fewer token of
    that colour. The gold count stays the same, so a token is saved; the
    colour is listed in `keptByGold` for the line "Gold covers 2 Red, so you
    keep 1 Red".
  - Gold tokens are used first, then gold bonuses. When that would use an odd
    number of gold bonuses and a gold token is in the payment, one more bonus
    replaces that token: the same card is discarded either way, so its second
    bonus is not thrown away. `preferGoldCards` uses gold bonuses first instead.
  - A sacrifice card pays nothing, and `sacrifice` says which cards it costs.
  - An unassigned Satchel card without a gem-bonus card is never ok (code
    `SATCHEL_NEEDS_GEM_CARD`).

  The result always carries all six token keys in `tokens`. When `ok` is true,
  `checkPayment` has accepted those tokens. When it is false, `shortBy` is how
  many more gems (or bonuses, for a sacrifice) the player needs.
- `paymentRoutes(card, player)` runs both routes. `distinct` is true when both
  are valid and differ, which is when the sheet offers "Use double-gold card
  first".
- `canAfford(card, player)` returns `{level, shortBy, reason}`. The level is
  `yes` (gems and bonuses alone), `gold` (gold tokens or gold bonuses needed)
  or `no`. When it is `no`, `reason` is `short`, `bonuses` (a sacrifice) or
  `satchel`.
- `satchelBlocked(card, player)` is the Satchel prerequisite on its own.
- `sacrificeInfo(card, player)` mirrors `OrientPlayer.findOptimizedBurn` for a
  card whose cost type is Bonus. Among the player's cards of the cost colour it
  picks two single-bonus cards (assigned satchels first, then the fewest
  prestige) or one double-bonus card, whichever loses fewer points. On a tie
  it takes the two singles, and it always takes them when a satchel leads. It
  returns `{ok, colour, needed, cards, cardIds, pointsLost}`, or null for any
  other card. The server takes the first cost colour of a hash map; every
  sacrifice card in the catalog costs a single colour, so the order never
  matters.
- `reserveOutcome(state, player, card?)` returns `{ok, reason, code, gold}`.
  `gold` is `gain` (the bank has gold and the player holds fewer than 10),
  `bank-empty`, or `needs-return` (the player holds 10). Refusals carry a
  reason for the disabled button: "You hold 3 reserved cards", "Not your
  turn", "This card is gone", "This card is already reserved".
- `reserveReturnOptions(player)` lists what may go back when reserving at 10:
  every gem colour held, then Gold (the gold just taken may go straight back).
- `buildReservePayload(cardId, putBackToken?)` gives `{cardId}` or
  `{cardId, putBackToken}`. The server gives the gold at 10 tokens only with a
  `putBackToken`, and refuses a `putBackToken` in any other case.
- `buildBuyPayload(cardId, tokens)` gives `{cardId, tokens}` with all six keys.

## progress.js

All counts are bonuses (cards owned), never tokens, and gold bonuses never
count.

- `nobleProgress(noble, player)` returns `{qualified, toGo, gap, rows}`. `toGo`
  is the badge number ("3 to go"). Whether a noble may visit this turn also
  depends on `nobleVisitedThisTurn`, which it does not look at.
- `cityProgress(city, player)` mirrors `CitiesGame.qualifiesCities`: the named
  colours, the prestige (`pointsShort`), and the same-colour requirement
  (`same`): `numSameBonuses` bonuses of one gem colour that the city does not
  name. `same.colour` is the best such colour so far. `toGo` counts missing
  bonuses, named and same-colour together; points are separate.
- `powerProgress(key, player)` and `powersProgress(player)` cover the five
  Trading Posts powers. Requirements come from `player[key].requirements` when
  the state carries them, otherwise from `POWERS`. Power 4 also needs a noble.
  `met` means the condition holds now; the server unlocks a power at the end of
  the turn in which it is met, and an unlocked power stays unlocked even if a
  sacrifice later lowers the bonuses.

## errors.js

`mapServerError(text, status)` returns `{code, copy, raw}`, where `raw` is the
trimmed server text for the small print under the copy.

- Status 0, or a browser's failed-fetch message ("Failed to fetch",
  "NetworkError…", "Load failed"), gives `NETWORK`: "Couldn't reach the table.
  Check your connection and try again."
- Status 500 and up gives `SERVER_ERROR`: "The server hit a problem. Checking
  whether your move went through…". The submit pipeline then waits for the
  next state before it shows anything final.
- Status 401 gives `TOKEN_MISMATCH`.
- Otherwise the trimmed text is matched against `ERROR_RULES` in order, as a
  case-insensitive prefix. Matching by prefix means a server message can grow
  a longer ending without breaking the copy: the real server's "You would end
  up with more than 10 tokens. Return tokens (putBackTokens) to get back down
  to 10." still maps. A few free-form messages carry a card id before the
  part that matters, and are matched by a regular expression instead.
- Anything else gives `UNKNOWN`: "The server refused that move."

The codes are the server's ActionResult names where one exists. The design's
table covers the ActionResult messages. The module also maps the free-form
`SplendorException` messages a player can trigger, so none of them falls back
to the default copy:

- malformed bodies, including the decoder's "Invalid data given for action …"
  wrapper (`MALFORMED`);
- a card that has left the board (`CARD_GONE`);
- the Satchel prerequisite on a purchase or a cascade (`SATCHEL_NEEDS_GEM_CARD`);
- a satchel colour sent for a card that is not an unassigned satchel
  (`SATCHEL_ALREADY_SET`);
- a cascade card of the wrong tier (`CASCADE_WRONG_TIER`);
- nobles and cities that are gone or not qualified for (`NOBLE_GONE`,
  `NOBLE_NOT_QUALIFIED`, `CITY_GONE`, `CITY_NOT_QUALIFIED`, `NO_CITIES`);
- a session or seat that does not exist (`SESSION_GONE`, `NOT_SEATED`).

`ERROR_COPY` holds the copy of every code, for callers that need it without a
server message.

## Tests

Run them with `pnpm test:unit` in `client/`, or one file at a time with
`node --test tests/unit/sp-rules-take.test.mjs`. They import the offline
engine (`tests/fixtures/engine.mjs`), the fixture states and cards, and the
e2e bot (`tests/e2e/lib/bot.mjs`, for seeded games and its reference
`paymentFor` and `qualifiesForCity`) without changing them.

- `sp-rules-common.test.mjs`: the phases (against the engine's turn order),
  seat colours with duplicate and invalid colours, card lookups, cascade
  choices and satchel colours against the engine.
- `sp-rules-take.test.mjs`: every tap rule and hint, returns, Pass. Then 200
  states taken at the start of main turns of seeded engine games (50 per game
  version, over 2-, 3- and 4-player games), plus 60 copies with 2 to 4 gem
  piles emptied, because bot games never empty the bank that far. For each
  state, every client-legal take with every valid return is sent to an engine
  replayed to that state and must be accepted, and invalid returns must be
  refused. Every one of the 242 non-empty take maps the engine accepts must be
  client-legal when it meets the strict singles rule, and client-illegal when
  it does not.
- `sp-rules-pay.test.mjs`: the judge regressions (gold worth 2 with a deficit
  of 1 Red and 1 Blue and one gold token is "no"; a satchel without a gem card
  is blocked), gold rounding, double-gold waste, sacrifices against the
  engine's burn, reserving at 10. A fuzz test compares `checkPayment` with the
  engine's verdict on every offer of 800 random players and cards, and checks
  that `autoPayment` is ok exactly when some offer is accepted. Over the same
  200 seeded states, for every visible and reserved card of every player,
  `autoPayment` is ok exactly when the bot's reference `paymentFor` finds a
  payment, the engine accepts both payment routes, and the current player's
  purchase goes through the engine.
- `sp-progress.test.mjs`: noble, city and power progress against
  `Engine.qualifiesForNoble`, `Engine.qualifiesCities` and the engine's
  Trading Posts checks, on random bonuses and on the seeded states.
- `sp-errors.test.mjs`: the design's copy table word for word, case and space
  handling, the real server's wordings and transport failures. It triggers 51
  refusals from the engine and checks that each maps to its own copy, and that
  together they cover every message text and every throw site in the engine
  source.

The take cross-check is the slowest file, at about 5 seconds.

## Limits

- The engine is a test double of the server. When the server's rules change,
  the e2e suites against a real stack are the authority, and the engine and
  these modules should be brought in line together.
- The client never sends a take of fewer singles than the bank allows, and
  never sends an empty take except through Pass.
