package ca.hexanome04.splendorgame.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

import ca.hexanome04.splendorgame.control.GameSavesManager;
import ca.hexanome04.splendorgame.control.SplendorTypeAdapter;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesPlayer;
import ca.hexanome04.splendorgame.model.gameversions.cities.CityCard;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsGame;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Plays complete games with {@link SimulationBot} for 2, 3 and 4 players in every game version, with the real
 * card files (src/main/resources), and checks the game's invariants after every single action.
 *
 * <p>Shuffles are seeded, so a failure names the version, player count and seed that reproduce it.
 * Each game is also saved and loaded once mid-game, and play continues on the loaded copy.</p>
 */
public class FullGameSimulationTests {

    /** Seeds per version and player count; raise it for a soak run with -Dsim.seeds=200. */
    private static final int SEEDS = Integer.getInteger("sim.seeds", 6);
    /** Safety cap: a game that has not ended after this many rounds fails the test. */
    private static final int MAX_ROUNDS = 150;
    /** Actions within one turn (main action plus follow-ups) before the test gives up. */
    private static final int MAX_ACTIONS_PER_TURN = 12;
    private static final int ROUND_TO_SAVE = 8;

    private static String realCards;
    private static String realCities;

    /** How often each kind of action was played over all simulated games (printed at the end). */
    private static final Map<String, Integer> USAGE = new ConcurrentHashMap<>();
    private static final AtomicInteger GAMES_PLAYED = new AtomicInteger();

    @BeforeAll
    static void findCardFiles() {
        Path cards = Path.of("src/main/resources/cards.csv").toAbsolutePath();
        Path cities = Path.of("src/main/resources/citycards.csv").toAbsolutePath();
        assertThat(cards).exists();
        assertThat(cities).exists();
        realCards = cards.toUri().toString();
        realCities = cities.toUri().toString();
    }

    /**
     * Create a game exactly as the server does (SessionManager.launchNewGame), but with the real card files
     * and a seeded shuffle.
     *
     * @param version game version
     * @param players number of players
     * @param seed shuffle seed
     * @return a new game, ready to play
     */
    static OrientGame newGame(GameVersions version, int players, long seed) {
        OrientGame game = switch (version) {
            case BASE_ORIENT -> new OrientGame(15, 0);
            case BASE_ORIENT_CITIES, BASE_ORIENT_CITIES_NOBLES -> new CitiesGame(version, 0);
            case BASE_ORIENT_TRADE_ROUTES -> new TradingPostsGame(15, 0);
        };
        game.setShuffleRandom(new Random(seed));
        game.setCardsResource(realCards);
        if (game instanceof CitiesGame cg) {
            cg.setCityCardsResource(realCities);
        }
        List<Player> list = new ArrayList<>();
        for (int i = 1; i <= players; i++) {
            list.add(game.createPlayer("Bot" + i, "colour" + i));
        }
        game.setPlayers(list);
        game.createSplendorBoard();
        game.initBoard();
        return game;
    }

    static int gemsPerPile(int players) {
        return switch (players) {
            case 2 -> 4;
            case 3 -> 5;
            case 4 -> 7;
            default -> throw new IllegalArgumentException("players: " + players);
        };
    }

    static boolean dealsNobles(GameVersions version) {
        return version != GameVersions.BASE_ORIENT_CITIES;
    }

    static Stream<Arguments> games() {
        List<Arguments> args = new ArrayList<>();
        for (GameVersions version : GameVersions.values()) {
            for (int players = 2; players <= 4; players++) {
                for (int s = 0; s < SEEDS; s++) {
                    args.add(Arguments.of(version, players, 1000L * players + 17L * s + version.ordinal()));
                }
            }
        }
        return args.stream();
    }

    // ---------------------------------------------------------------- setup

    @DisplayName("Two-player setup: 4 gems per colour, 5 gold, 3 nobles (none in Cities), full card rows")
    @ParameterizedTest
    @EnumSource(GameVersions.class)
    void testTwoPlayerSetup(GameVersions version) {
        OrientGame game = newGame(version, 2, 42);
        checkSetup(game, version, 2);
    }

    @DisplayName("Three- and four-player setup: 5 or 7 gems per colour, players + 1 nobles")
    @ParameterizedTest
    @EnumSource(GameVersions.class)
    void testThreeAndFourPlayerSetup(GameVersions version) {
        checkSetup(newGame(version, 3, 7), version, 3);
        checkSetup(newGame(version, 4, 7), version, 4);
    }

    private static void checkSetup(OrientGame game, GameVersions version, int players) {
        for (TokenType t : SimulationBot.GEMS) {
            assertThat(game.getTokens().get(t)).as(t.name()).isEqualTo(gemsPerPile(players));
        }
        assertThat(game.getTokens().get(TokenType.Gold)).isEqualTo(5);
        assertThat(game.getTokens().get(TokenType.Satchel)).isEqualTo(0);
        assertThat(game.getNobles()).hasSize(dealsNobles(version) ? players + 1 : 0);
        assertThat(game.getTier1PurchasableDevelopmentCards()).hasSize(4);
        assertThat(game.getTier2PurchasableDevelopmentCards()).hasSize(4);
        assertThat(game.getTier3PurchasableDevelopmentCards()).hasSize(4);
        assertThat(game.getTier1PurchasableOrientCards()).hasSize(2);
        assertThat(game.getTier2PurchasableOrientCards()).hasSize(2);
        assertThat(game.getTier3PurchasableOrientCards()).hasSize(2);
        if (game instanceof CitiesGame cg) {
            assertThat(cg.getCitiesDeck().getVisibleCards()).hasSize(3);
        }
        assertThat(game.getTurnCounter()).isEqualTo(0);
        assertThat(game.getCurValidActions()).containsExactly(Actions.BUY_CARD, Actions.TAKE_TOKEN,
                Actions.RESERVE_CARD);
        for (Player p : game.getPlayers()) {
            assertThat(p.getTokens().values().stream().mapToInt(Integer::intValue).sum()).isEqualTo(0);
        }
        // the whole real card file is loaded: 40 + 30 + 20 regular cards, 10 Orient cards per tier, 11 nobles
        int[] deckSizes = {40, 30, 20, 10, 10, 10};
        List<Deck<? extends DevelopmentCard>> decks = game.getDevelopmentDecks();
        for (int i = 0; i < decks.size(); i++) {
            Deck<? extends DevelopmentCard> d = decks.get(i);
            assertThat(d.getVisibleCards().size() + d.getHiddenCardCount()).as("deck " + i).isEqualTo(deckSizes[i]);
        }
        assertThat(game.getNobles().size() + game.getNobleDeck().getHiddenCardCount()).isEqualTo(11);
    }

    @Test
    @DisplayName("The same seed deals the same board, another seed a different one")
    void testSeedIsDeterministic() {
        for (GameVersions version : GameVersions.values()) {
            assertThat(boardIds(newGame(version, 2, 5))).isEqualTo(boardIds(newGame(version, 2, 5)));
            assertThat(boardIds(newGame(version, 2, 5))).isNotEqualTo(boardIds(newGame(version, 2, 6)));
        }
    }

    private static List<String> boardIds(OrientGame game) {
        List<String> ids = new ArrayList<>();
        SimulationBot.allVisible(game).forEach(c -> ids.add(c.getId()));
        game.getNobles().forEach(c -> ids.add(c.getId()));
        if (game instanceof CitiesGame cg) {
            cg.getCitiesDeck().getVisibleCards().forEach(c -> ids.add(c.getId()));
        }
        return ids;
    }

    // ---------------------------------------------------------------- full games

    @DisplayName("Full game with legal moves only; invariants hold after every action")
    @ParameterizedTest(name = "{0}, {1} players, seed {2}")
    @MethodSource("games")
    void testFullGame(GameVersions version, int players, long seed) throws Exception {
        OrientGame game = newGame(version, players, seed);
        SimulationBot bot = new SimulationBot(new Random(seed * 31 + 7));
        Map<String, Integer> turns = new HashMap<>();
        game.getPlayers().forEach(p -> turns.put(p.getName(), 0));
        String context = version + ", " + players + " players, seed " + seed;
        boolean saved = false;
        int rounds = 0;

        checkInvariants(game, version, players, context);
        while (!game.isGameOver()) {
            if (rounds >= MAX_ROUNDS) {
                fail("Game did not end after " + MAX_ROUNDS + " rounds: " + context + "; "
                        + describe(game));
            }
            if (!saved && rounds == ROUND_TO_SAVE && game.getTurnCounter() == 0) {
                game = saveAndLoad(game);
                saved = true;
                checkInvariants(game, version, players, context + " (after loading)");
            }

            Player current = game.getTurnCurrentPlayer();
            int seat = game.getTurnCounter();
            int actions = 0;
            while (!game.isGameOver() && game.getTurnCounter() == seat) {
                if (++actions > MAX_ACTIONS_PER_TURN) {
                    fail("Turn of " + current.getName() + " did not end: " + context + "; " + describe(game));
                }
                Action action = bot.chooseAction(game, current);
                USAGE.merge(bot.getLastKind(), 1, Integer::sum);
                List<ActionResult> result = game.takeAction(current.getName(), action);
                if (!result.contains(ActionResult.VALID_ACTION)) {
                    fail("Legal move " + action.getClass().getSimpleName() + " " + action.getActionType()
                            + " was rejected with " + result + ": " + context + "; " + describe(game));
                }
                checkInvariants(game, version, players, context);
            }
            turns.put(current.getName(), turns.get(current.getName()) + 1);
            if (seat == players - 1) {
                rounds++;
            }
        }

        System.out.println("simulated " + context + ": " + rounds + " rounds, winners "
                + game.getWinner().stream().map(p -> p.getName() + "(" + p.getPrestigePoints() + "pp, "
                + p.getDevCards().size() + " cards)").collect(Collectors.joining(", ")));
        assertThat(saved).as("saved and loaded mid-game: " + context).isTrue();
        GAMES_PLAYED.incrementAndGet();
        // the round was finished: every player had the same number of turns
        assertThat(new HashSet<>(turns.values())).as("turns per player " + turns + ": " + context).hasSize(1);
        checkWinners(game, version, context);
    }

    @AfterAll
    static void checkUsage() {
        System.out.println("simulated " + GAMES_PLAYED.get() + " games, action usage: " + new TreeMap<>(USAGE));
        if (GAMES_PLAYED.get() < GameVersions.values().length * 3 * SEEDS) {
            return; // only part of the games ran (a single test was selected)
        }
        // the simulated games must keep exercising every kind of follow-up and the less common moves
        for (String kind : List.of("CASCADE_1", "CASCADE_2", "CHOOSE_SATCHEL_TOKEN", "RESERVE_NOBLE", "CHOOSE_NOBLE",
                "CHOOSE_CITY", "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", "buy (sacrifice)", "buy (reserved card)",
                "buy (holding gold bonus)", "reserve", "take (with put-back)")) {
            assertThat(USAGE.getOrDefault(kind, 0)).as("simulated games played " + kind).isPositive();
        }
    }

    private static OrientGame saveAndLoad(OrientGame game) throws Exception {
        File dir = Files.createTempDirectory("splendor-sim-saves").toFile();
        try {
            GameSavesManager saves = new GameSavesManager(dir.getAbsolutePath(), "all.json", new SplendorTypeAdapter("splendor"));
            String id = saves.createGameSave("simulation", "Bot1", game);
            assertThat(id).isNotEmpty();
            OrientGame loaded = (OrientGame) saves.getGameSaveData(id);
            assertThat(loaded).isNotNull();
            assertThat(loaded.getClass()).isEqualTo(game.getClass());
            assertThat(loaded.getGameVersion()).isEqualTo(game.getGameVersion());
            assertThat(boardIds(loaded)).isEqualTo(boardIds(game));
            return loaded;
        } finally {
            try (Stream<Path> files = Files.walk(dir.toPath())) {
                files.sorted((a, b) -> b.compareTo(a)).forEach(f -> f.toFile().delete());
            }
        }
    }

    private static void checkWinners(OrientGame game, GameVersions version, String context) {
        List<Player> candidates = new ArrayList<>();
        for (Player p : game.getPlayers()) {
            boolean reached = game instanceof CitiesGame
                    ? !((CitiesPlayer) p).getCities().isEmpty()
                    : p.getPrestigePoints() >= game.getPrestigePointsToWin();
            if (reached) {
                candidates.add(p);
            }
        }
        assertThat(candidates).as("someone reached the end condition: " + context).isNotEmpty();
        int most = candidates.stream().mapToInt(Player::getPrestigePoints).max().getAsInt();
        int fewest = candidates.stream().filter(p -> p.getPrestigePoints() == most)
                .mapToInt(p -> p.getDevCards().size()).min().getAsInt();
        Set<String> expected = candidates.stream()
                .filter(p -> p.getPrestigePoints() == most && p.getDevCards().size() == fewest)
                .map(Player::getName).collect(Collectors.toSet());
        Set<String> actual = game.getWinner().stream().map(Player::getName).collect(Collectors.toSet());
        assertThat(actual).as("winners: " + context + "; " + describe(game)).isEqualTo(expected);
        assertThat(game.getWinner()).hasSameSizeAs(actual);
    }

    // ---------------------------------------------------------------- invariants

    private static void checkInvariants(OrientGame game, GameVersions version, int players, String context) {
        String where = context + " at turn " + game.getTurnCounter();

        // token conservation per colour, and nobody above 10 tokens or below 0
        Map<TokenType, Integer> sum = new HashMap<>(game.getTokens());
        for (Player p : game.getPlayers()) {
            int held = 0;
            for (Map.Entry<TokenType, Integer> e : p.getTokens().entrySet()) {
                assertThat(e.getValue()).as(p.getName() + " " + e.getKey() + ": " + where).isGreaterThanOrEqualTo(0);
                held += e.getValue();
                sum.merge(e.getKey(), e.getValue(), Integer::sum);
            }
            assertThat(held).as(p.getName() + " holds at most 10 tokens: " + where).isLessThanOrEqualTo(10);
            assertThat(p.getReservedCards().size()).as(p.getName() + " reserved: " + where).isLessThanOrEqualTo(3);
        }
        for (Map.Entry<TokenType, Integer> e : game.getTokens().entrySet()) {
            assertThat(e.getValue()).as("board " + e.getKey() + ": " + where).isGreaterThanOrEqualTo(0);
        }
        for (TokenType t : SimulationBot.GEMS) {
            assertThat(sum.get(t)).as("total " + t + ": " + where).isEqualTo(gemsPerPile(players));
        }
        assertThat(sum.get(TokenType.Gold)).as("total gold: " + where).isEqualTo(5);
        assertThat(sum.getOrDefault(TokenType.Satchel, 0)).as("satchel tokens: " + where).isEqualTo(0);

        // nobles: dealt once at the start, then only move between the board and the players
        int nobles = game.getNobles().size();
        for (Player p : game.getPlayers()) {
            nobles += p.getNobles().size() + p.getReservedNobles().size();
        }
        assertThat(nobles).as("nobles in play: " + where).isEqualTo(dealsNobles(version) ? players + 1 : 0);

        // cities: 3 dealt, taken at most one per player
        if (game instanceof CitiesGame cg) {
            int cities = cg.getCitiesDeck().getVisibleCards().size();
            for (Player p : game.getPlayers()) {
                List<CityCard> owned = ((CitiesPlayer) p).getCities();
                assertThat(owned.size()).as(p.getName() + " cities: " + where).isLessThanOrEqualTo(1);
                cities += owned.size();
            }
            assertThat(cities).as("cities in play: " + where).isEqualTo(3);
        }

        // no card is in two places at once
        Set<String> seen = new HashSet<>();
        List<Card> everywhere = new ArrayList<>(SimulationBot.allVisible(game));
        everywhere.addAll(game.getNobles());
        for (Player p : game.getPlayers()) {
            everywhere.addAll(p.getDevCards());
            everywhere.addAll(p.getReservedCards());
            everywhere.addAll(p.getNobles());
            everywhere.addAll(p.getReservedNobles());
        }
        for (Card c : everywhere) {
            assertThat(seen.add(c.getId())).as("card " + c.getId() + " appears twice: " + where).isTrue();
        }

        // bonuses and prestige match the cards each player owns
        for (Player p : game.getPlayers()) {
            Map<TokenType, Integer> fromCards = new HashMap<>();
            int points = 3 * p.getNobles().size();
            for (DevelopmentCard c : p.getDevCards()) {
                if (c.getTokenType() != null && c.getTokenType() != TokenType.Satchel) {
                    fromCards.merge(c.getTokenType(), c.getBonus(), Integer::sum);
                }
                points += c.getPrestigePoints();
            }
            for (TokenType t : TokenType.values()) {
                int expected = t == TokenType.Satchel ? 0 : fromCards.getOrDefault(t, 0);
                assertThat(p.getBonuses().getOrDefault(t, 0)).as(p.getName() + " bonus " + t + ": " + where)
                        .isEqualTo(expected);
            }
            if (game instanceof TradingPostsGame) {
                // powers 4 and 5 add at most 5 points each
                assertThat(p.getPrestigePoints()).as(p.getName() + " points: " + where)
                        .isBetween(points, points + 10);
            } else {
                assertThat(p.getPrestigePoints()).as(p.getName() + " points: " + where).isEqualTo(points);
            }
        }

        // the turn state is consistent
        if (game.isGameOver()) {
            assertThat(game.getCurValidActions()).as("actions after game over: " + where).isEmpty();
            assertThat(game.getWinner()).as("winners: " + where).isNotEmpty();
        } else {
            List<Actions> valid = game.getCurValidActions();
            assertThat(valid).as("pending actions: " + where).isNotEmpty();
            assertThat(new HashSet<>(valid)).as("no duplicate actions: " + where).hasSameSizeAs(valid);
            assertThat(game.getTurnCurrentPlayer()).isNotNull();
        }
    }

    private static String describe(OrientGame game) {
        StringBuilder sb = new StringBuilder();
        sb.append("turn=").append(game.getTurnCounter()).append(" actions=").append(game.getCurValidActions())
                .append(" board=").append(game.getTokens());
        for (Player p : game.getPlayers()) {
            sb.append(" | ").append(p.getName()).append(" pp=").append(p.getPrestigePoints())
                    .append(" cards=").append(p.getDevCards().size())
                    .append(" reserved=").append(p.getReservedCards().size())
                    .append(" tokens=").append(p.getTokens()).append(" bonuses=").append(p.getBonuses());
        }
        return sb.toString();
    }
}
