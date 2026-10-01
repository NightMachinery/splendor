package ca.hexanome04.splendorgame.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ca.hexanome04.splendorgame.model.action.ActionDecoder;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.action.actions.BuyCardAction;
import ca.hexanome04.splendorgame.model.action.actions.CascadeTier1Action;
import ca.hexanome04.splendorgame.model.action.actions.CascadeTier2Action;
import ca.hexanome04.splendorgame.model.action.actions.ChooseNobleAction;
import ca.hexanome04.splendorgame.model.action.actions.ChooseTokenTypeAction;
import ca.hexanome04.splendorgame.model.action.actions.ReserveCardAction;
import ca.hexanome04.splendorgame.model.action.actions.TakeTokenAction;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesPlayer;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsGame;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Regression tests for rule fixes in the game model, using the small test card file
 * (src/test/resources/cards.csv, where every card is visible from the start).
 */
public class RuleFixesTests {

    private static final List<Actions> MAIN_ACTIONS = List.of(Actions.BUY_CARD, Actions.TAKE_TOKEN,
            Actions.RESERVE_CARD);

    private static HashMap<TokenType, Integer> tokens(Object... typeAndAmount) {
        HashMap<TokenType, Integer> map = new HashMap<>();
        for (int i = 0; i < typeAndAmount.length; i += 2) {
            map.put((TokenType) typeAndAmount[i], (Integer) typeAndAmount[i + 1]);
        }
        return map;
    }

    private static ArrayList<ActionResult> pass(OrientGame game, Player p) {
        return game.takeAction(p.getName(), new TakeTokenAction(new HashMap<>(), new HashMap<>()));
    }

    private static void giveDummyCards(Player p, int count) {
        for (int i = 0; i < count; i++) {
            p.addCard(new RegDevelopmentCard(CardTier.TIER_1, TokenType.Red, 0, 0, CostType.Token,
                    tokens(TokenType.Red, 1), "dummy-" + p.getName() + "-" + i));
        }
    }

    private static int totalTokens(Player p) {
        return p.getTokens().values().stream().mapToInt(Integer::intValue).sum();
    }

    // ---------------------------------------------------------------- winner rule

    @DisplayName("More prestige points beat fewer development cards")
    @Test
    void testMorePrestigeBeatsFewerCards() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        p1.addPrestigePoints(14);
        p1.addTokens(tokens(TokenType.Red, 4));
        p2.addPrestigePoints(16);
        giveDummyCards(p2, 2);

        // Player1 reaches 15 with 1 card; Player2 finishes the round on 16 with 2 cards
        game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 4)));
        assertThat(game.isGameOver()).isFalse();
        pass(game, p2);

        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getWinner()).containsExactly(p2);
    }

    @DisplayName("A prestige tie is broken by the fewest development cards")
    @Test
    void testPrestigeTieBrokenByFewestCards() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        p1.addPrestigePoints(15);
        giveDummyCards(p1, 2);
        p2.addPrestigePoints(15);
        giveDummyCards(p2, 1);

        pass(game, p1);
        pass(game, p2);

        assertThat(game.getWinner()).containsExactly(p2);
    }

    @DisplayName("A player below the target never wins, even with fewer cards")
    @Test
    void testPlayerBelowTargetDoesNotWin() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        p1.addPrestigePoints(15);
        giveDummyCards(p1, 3);
        p2.addPrestigePoints(14);

        pass(game, p1);
        pass(game, p2);

        assertThat(game.getWinner()).containsExactly(p1);
    }

    @DisplayName("With 3 players the round is finished, so every player has the same number of turns")
    @Test
    void testRoundIsFinishedWithThreePlayers() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 3);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        Player p3 = game.getPlayerFromName("Player3");

        pass(game, p1);
        p2.addPrestigePoints(15);
        pass(game, p2);
        // the second seat reached the target, but the third seat still plays
        assertThat(game.isGameOver()).isFalse();
        assertThat(game.getTurnCounter()).isEqualTo(2);
        assertThat(game.getPlayersWhoCanWin()).containsExactly(p2);

        pass(game, p3);
        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getWinner()).containsExactly(p2);
    }

    @DisplayName("When the first seat reaches the target the whole round is still played")
    @Test
    void testFirstSeatReachingTargetWaitsForRound() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 3);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addPrestigePoints(15);

        pass(game, p1);
        assertThat(game.isGameOver()).isFalse();
        pass(game, game.getPlayerFromName("Player2"));
        assertThat(game.isGameOver()).isFalse();
        pass(game, game.getPlayerFromName("Player3"));
        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getWinner()).containsExactly(p1);
    }

    @DisplayName("After the game is over nobody can act and there is no current player")
    @Test
    void testGameOverState() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addPrestigePoints(15);
        pass(game, p1);
        pass(game, game.getPlayerFromName("Player2"));

        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getTurnCurrentPlayer()).isNull();
        assertThat(game.getCurValidActions()).isEmpty();
        assertThat(game.getTurnCounter()).isEqualTo(OrientGame.GAME_OVER_TURN_COUNTER);
        assertThat(pass(game, p1)).containsExactly(ActionResult.GAME_OVER);
    }

    // ---------------------------------------------------------------- Cities winner rule and requirements

    @DisplayName("Cities: among players who took a city, the most prestige points win")
    @Test
    void testCitiesWinnerMostPrestige() throws FileNotFoundException {
        CitiesGame game = GameUtils.createNewCitiesGame(2);
        CitiesPlayer p1 = (CitiesPlayer) game.getPlayerFromName("Player1");
        CitiesPlayer p2 = (CitiesPlayer) game.getPlayerFromName("Player2");
        p1.addPrestigePoints(17);
        p2.addPrestigePoints(16);
        p2.addBonus(TokenType.White, 5);

        pass(game, p1);
        assertThat(p1.getCities()).extracting(Card::getId).containsExactly("40003");
        pass(game, p2);
        assertThat(p2.getCities()).extracting(Card::getId).containsExactly("40012");

        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getWinner()).containsExactly(p1);
    }

    @DisplayName("Cities: a prestige tie between city holders is broken by the fewest development cards")
    @Test
    void testCitiesWinnerTieBrokenByCards() throws FileNotFoundException {
        CitiesGame game = GameUtils.createNewCitiesGame(2);
        CitiesPlayer p1 = (CitiesPlayer) game.getPlayerFromName("Player1");
        CitiesPlayer p2 = (CitiesPlayer) game.getPlayerFromName("Player2");
        p1.addPrestigePoints(17);
        giveDummyCards(p1, 2);
        p2.addPrestigePoints(17);
        p2.addBonus(TokenType.White, 5);
        giveDummyCards(p2, 1);

        pass(game, p1);
        pass(game, p2);

        assertThat(p1.getCities()).hasSize(1);
        assertThat(p2.getCities()).hasSize(1);
        assertThat(game.getWinner()).containsExactly(p2);
    }

    @DisplayName("Cities: gold bonuses do not count towards a 'same colour' requirement")
    @Test
    void testCitiesSameColourIgnoresGold() throws FileNotFoundException {
        CitiesGame game = GameUtils.createNewCitiesGame(2);
        CitiesPlayer p1 = (CitiesPlayer) game.getPlayerFromName("Player1");
        p1.addPrestigePoints(15);
        p1.addBonus(TokenType.Gold, 6);

        pass(game, p1);
        assertThat(p1.getCities()).isEmpty();
        pass(game, game.getPlayerFromName("Player2"));
        assertThat(game.isGameOver()).isFalse();

        // five bonuses of one gem colour do qualify for city 40012 (15 points and 5 of one colour)
        p1.addBonus(TokenType.White, 5);
        pass(game, p1);
        assertThat(p1.getCities()).extracting(Card::getId).containsExactly("40012");
    }

    // ---------------------------------------------------------------- token validation

    @DisplayName("Gold and the Satchel placeholder cannot be taken with TAKE_TOKEN")
    @Test
    void testTakeGoldRejected() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");

        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Gold, 1), new HashMap<>())))
                .containsExactly(ActionResult.GOLD_CANNOT_BE_TAKEN);
        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Gold, 2), new HashMap<>())))
                .containsExactly(ActionResult.GOLD_CANNOT_BE_TAKEN);
        assertThat(game.takeAction(p1.getName(),
                new TakeTokenAction(tokens(TokenType.Gold, 1, TokenType.Red, 1, TokenType.Blue, 1), new HashMap<>())))
                .containsExactly(ActionResult.GOLD_CANNOT_BE_TAKEN);
        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Satchel, 1), new HashMap<>())))
                .containsExactly(ActionResult.GOLD_CANNOT_BE_TAKEN);

        // nothing changed
        assertThat(game.getTokens().get(TokenType.Gold)).isEqualTo(5);
        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(0);
        assertThat(game.getTurnCounter()).isEqualTo(0);
        assertThat(game.getCurValidActions()).isEqualTo(MAIN_ACTIONS);
    }

    @DisplayName("Negative token amounts are rejected when taking or returning tokens")
    @Test
    void testNegativeTokenAmountsRejected() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");

        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Red, -1), new HashMap<>())))
                .containsExactly(ActionResult.INVALID_TOKENS_GIVEN);
        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Red, 1, TokenType.Blue, 1),
                tokens(TokenType.Gold, -3)))).containsExactly(ActionResult.INVALID_TOKENS_GIVEN);

        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(0);
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(0);
        assertThat(game.getTokens().get(TokenType.Red)).isEqualTo(4);
        assertThat(game.getTurnCounter()).isEqualTo(0);
    }

    @DisplayName("Request bodies with negative, fractional or unknown token amounts are refused")
    @Test
    void testDecoderRejectsBadAmounts() {
        String[][] bad = {
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":1.5},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":-1},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":\"many\"},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":true},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Ruby\":1},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":1},\"putBackTokens\":{\"Gold\":-3}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":[1,2]}"},
            {"TAKE_TOKEN", "{}"},
            {"BUY_CARD", "{\"cardId\":\"01\",\"tokens\":{\"Red\":-2}}"},
            {"BUY_CARD", "{\"cardId\":\"01\",\"tokens\":{\"Gold\":0.5}}"},
            {"BUY_CARD", "{\"cardId\":{\"id\":1},\"tokens\":{}}"},
            {"BUY_CARD", "{\"tokens\":{}}"},
            {"RESERVE_CARD", "{}"},
            {"RESERVE_CARD", "{\"cardId\":\"01\",\"putBackToken\":\"Ruby\"}"},
            {"CHOOSE_SATCHEL_TOKEN", "{\"cardId\":\"11\"}"},
            {"CHOOSE_CITY", "{\"cityId\":\"\"}"},
        };
        for (String[] request : bad) {
            JsonObject body = JsonParser.parseString(request[1]).getAsJsonObject();
            assertThrows(SplendorException.class, () -> ActionDecoder.createAction(request[0], body),
                    request[0] + " " + request[1]);
        }
        assertThrows(SplendorException.class, () -> ActionDecoder.createAction("TAKE_TOKEN", null));

        // valid bodies still decode, and putBackTokens / putBackToken are optional
        String[][] good = {
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":1,\"Blue\":1},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":2}}"},
            {"BUY_CARD", "{\"cardId\":\"01\",\"tokens\":{\"Red\":4,\"Gold\":0}}"},
            {"RESERVE_CARD", "{\"cardId\":\"01\"}"},
            {"RESERVE_CARD", "{\"cardId\":\"01\",\"putBackToken\":\"Red\"}"},
            {"TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER", "{}"},
        };
        for (String[] request : good) {
            JsonObject body = JsonParser.parseString(request[1]).getAsJsonObject();
            assertThat(ActionDecoder.createAction(request[0], body)).isNotNull();
        }
    }

    @DisplayName("Tokens may only be returned to get back down to 10")
    @Test
    void testTokenLimitAndReturns() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.White, 2, TokenType.Blue, 2, TokenType.Green, 2, TokenType.Red, 2,
                TokenType.Brown, 1));
        HashMap<TokenType, Integer> three = tokens(TokenType.Red, 1, TokenType.Blue, 1, TokenType.Green, 1);

        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(three, new HashMap<>())))
                .containsExactly(ActionResult.MAXIMUM_TOKENS_IN_INVENTORY);
        assertThat(game.takeAction(p1.getName(), new TakeTokenAction(three, tokens(TokenType.White, 2,
                TokenType.Brown, 1)))).containsExactly(ActionResult.TOO_MANY_TOKENS_RETURNED);
        assertThat(totalTokens(p1)).isEqualTo(9);

        ArrayList<ActionResult> ok = game.takeAction(p1.getName(), new TakeTokenAction(three,
                tokens(TokenType.White, 2)));
        assertThat(ok).contains(ActionResult.VALID_ACTION);
        assertThat(totalTokens(p1)).isEqualTo(10);
        assertThat(p1.getTokens().get(TokenType.White)).isEqualTo(0);
    }

    @DisplayName("Two tokens of one colour need a pile of at least 4 (2 players start with 4 per pile)")
    @Test
    void testDoubleTakeNeedsFour() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");

        game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Red, 1, TokenType.Blue, 1,
                TokenType.Green, 1), new HashMap<>()));
        assertThat(game.getTokens().get(TokenType.Red)).isEqualTo(3);

        assertThat(game.takeAction(p2.getName(), new TakeTokenAction(tokens(TokenType.Red, 2), new HashMap<>())))
                .containsExactly(ActionResult.INVALID_TOKENS_GIVEN);
        assertThat(game.takeAction(p2.getName(), new TakeTokenAction(tokens(TokenType.White, 2), new HashMap<>())))
                .contains(ActionResult.VALID_ACTION);
        assertThat(game.getTokens().get(TokenType.White)).isEqualTo(2);
    }

    // ---------------------------------------------------------------- purchases

    @DisplayName("Overpaying is rejected and leaves the game unchanged")
    @Test
    void testOverpaymentRejected() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Red, 5));

        assertThat(game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 5))))
                .containsExactly(ActionResult.PAYMENT_TOO_HIGH);
        assertThat(game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 5,
                TokenType.Blue, -1)))).containsExactly(ActionResult.INVALID_TOKENS_GIVEN);

        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(5);
        assertThat(p1.getTokens().get(TokenType.Blue)).isEqualTo(0);
        assertThat(p1.getDevCards()).isEmpty();
        assertThat(game.getCardFromId("01")).isNotNull();
        assertThat(game.getTokens().get(TokenType.Red)).isEqualTo(4);
        assertThat(game.getTurnCounter()).isEqualTo(0);
    }

    @DisplayName("A rejected purchase keeps the player's double gold card; an accepted one discards it")
    @Test
    void testRejectedPurchaseKeepsGoldCard() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        OrientDevelopmentCard goldCard = new OrientDevelopmentCard(CardTier.TIER_1, TokenType.Gold, 2,
                CascadeType.None, false, 0, CostType.Token, tokens(TokenType.Red, 3), "gold-card", false);
        p1.addCard(goldCard);
        p1.addBonus(TokenType.Gold, 2);
        p1.addTokens(tokens(TokenType.Red, 2));

        // card 01 costs 4 Red: 1 Red token plus 2 gold bonuses is not enough
        assertThat(game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 1))))
                .containsExactly(ActionResult.PAYMENT_TOO_LOW);
        assertThat(p1.getDevCards()).containsExactly(goldCard);
        assertThat(p1.getBonuses().get(TokenType.Gold)).isEqualTo(2);
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(2);

        // 2 Red tokens plus the 2 gold bonuses pay exactly; the double gold card is used up
        assertThat(game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 2))))
                .contains(ActionResult.VALID_ACTION);
        assertThat(p1.getDevCards()).extracting(Card::getId).containsExactly("01");
        assertThat(p1.getBonuses().get(TokenType.Gold)).isEqualTo(0);
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(0);
    }

    @DisplayName("Buying a noble id or an unknown id is a clear error, not a crash")
    @Test
    void testBuyingNonDevelopmentCardRejected() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");

        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(),
                new BuyCardAction("98", new HashMap<>())));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(),
                new BuyCardAction("no-such-card", new HashMap<>())));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new ReserveCardAction("98")));
        assertThat(game.getCardFromId("98")).isNotNull();
        assertThat(game.getCurValidActions()).isEqualTo(MAIN_ACTIONS);
    }

    @DisplayName("A sacrifice with a satchel and a double card of that colour discards the double card")
    @Test
    void testSacrificeWithSatchelAndDoubleCard() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        p1.addTokens(tokens(TokenType.Green, 2));

        // card 07: Red, two bonuses
        game.takeAction(p1.getName(), new BuyCardAction("07", tokens(TokenType.Green, 1)));
        pass(game, p2);
        // card 11: Satchel, assigned to Red
        game.takeAction(p1.getName(), new BuyCardAction("11", tokens(TokenType.Green, 1)));
        game.takeAction(p1.getName(), new ChooseTokenTypeAction("11", TokenType.Red));
        pass(game, p2);
        assertThat(p1.getBonuses().get(TokenType.Red)).isEqualTo(3);

        // card 10 costs two Red bonuses
        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new BuyCardAction("10", new HashMap<>()));
        assertThat(result).contains(ActionResult.VALID_ACTION);
        assertThat(p1.getDevCards()).extracting(Card::getId).containsExactlyInAnyOrder("11", "10");
        assertThat(p1.getBonuses().get(TokenType.Red)).isEqualTo(1);
        assertThat(p1.getBonuses().get(TokenType.Brown)).isEqualTo(1);
        assertThat(p1.getPrestigePoints()).isEqualTo(2);
    }

    // ---------------------------------------------------------------- cascades

    @DisplayName("CASCADE_1 only takes a visible tier 1 card")
    @Test
    void testCascadeTier1ValidatesTier() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Green, 1));

        // card 15 cascades into a tier 1 card
        game.takeAction(p1.getName(), new BuyCardAction("15", tokens(TokenType.Green, 1)));
        assertThat(game.getCurValidActions()).containsExactly(Actions.CASCADE_1);

        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier1Action("02")));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier1Action("03")));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier1Action("nope")));
        assertThat(game.takeAction(p1.getName(), new CascadeTier2Action("02")))
                .containsExactly(ActionResult.ACTION_NOT_ALLOWED);
        assertThat(game.getCardFromId("02")).isNotNull();
        assertThat(game.getCurValidActions()).containsExactly(Actions.CASCADE_1);
        assertThat(p1.getDevCards()).extracting(Card::getId).containsExactly("15");

        // a regular tier 1 card is fine, and the turn then ends
        assertThat(game.takeAction(p1.getName(), new CascadeTier1Action("01"))).contains(ActionResult.VALID_ACTION);
        assertThat(p1.getDevCards()).extracting(Card::getId).containsExactly("15", "01");
        assertThat(game.getTurnCounter()).isEqualTo(1);
    }

    @DisplayName("CASCADE_2 only takes a visible tier 2 card")
    @Test
    void testCascadeTier2ValidatesTier() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Green, 1));

        // card 14 cascades into a tier 2 card
        game.takeAction(p1.getName(), new BuyCardAction("14", tokens(TokenType.Green, 1)));
        assertThat(game.getCurValidActions()).containsExactly(Actions.CASCADE_2);

        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier2Action("01")));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier2Action("03")));
        assertThrows(SplendorException.class, () -> game.takeAction(p1.getName(), new CascadeTier2Action("13")));
        assertThat(game.takeAction(p1.getName(), new CascadeTier2Action("09"))).contains(ActionResult.VALID_ACTION);
        assertThat(game.getTurnCounter()).isEqualTo(1);
    }

    @DisplayName("A cascade with no card left to take is skipped instead of blocking the turn")
    @Test
    void testCascadeWithoutChoicesIsSkipped() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Green, 1));
        for (String id : List.of("01", "05", "08", "11", "12")) {
            game.takeCard(game.getCardFromId(id));
        }

        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new BuyCardAction("15",
                tokens(TokenType.Green, 1)));
        assertThat(result).doesNotContain(ActionResult.MUST_CHOOSE_CASCADE_CARD_TIER_1);
        assertThat(game.getTurnCounter()).isEqualTo(1);
        assertThat(game.getCurValidActions()).isEqualTo(MAIN_ACTIONS);
    }

    // ---------------------------------------------------------------- nobles and follow-ups

    @DisplayName("A reserve-noble card does not ask for a noble when none is left on the board")
    @Test
    void testReserveNobleSkippedWithoutNobles() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Green, 1));
        game.takeCard(game.getCardFromId("98"));
        game.takeCard(game.getCardFromId("99"));

        // card 13 lets its buyer reserve a noble
        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new BuyCardAction("13",
                tokens(TokenType.Green, 1)));
        assertThat(result).doesNotContain(ActionResult.MUST_RESERVE_NOBLE);
        assertThat(game.getTurnCounter()).isEqualTo(1);
    }

    @DisplayName("Cities without nobles: a reserve-noble card cannot get the turn stuck")
    @Test
    void testCitiesNoNoblesReserveNobleCard() throws FileNotFoundException {
        CitiesGame game = GameUtils.createNewCitiesGame(2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Green, 1));
        assertThat(game.getNobles()).isEmpty();

        game.takeAction(p1.getName(), new BuyCardAction("13", tokens(TokenType.Green, 1)));
        assertThat(p1.getReservedNobles()).isEmpty();
        assertThat(game.getTurnCounter()).isEqualTo(1);
    }

    @DisplayName("At most one noble visits per turn, and CHOOSE_NOBLE is listed once")
    @Test
    void testOneNoblePerTurn() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");
        p1.addBonus(TokenType.Green, 2);
        p1.addBonus(TokenType.Red, 2);
        p1.addBonus(TokenType.Brown, 1);

        // card 14 (Blue, cost covered by the Green bonuses) cascades into a tier 2 card; nothing to choose yet
        game.takeAction(p1.getName(), new BuyCardAction("14", new HashMap<>()));
        assertThat(game.getCurValidActions()).containsExactly(Actions.CASCADE_2);

        // card 06 (two Blue) makes the player qualify for both nobles
        ArrayList<ActionResult> cascade = game.takeAction(p1.getName(), new CascadeTier2Action("06"));
        assertThat(cascade).contains(ActionResult.MUST_CHOOSE_NOBLE);
        assertThat(game.getCurValidActions()).containsExactly(Actions.CHOOSE_NOBLE);

        game.takeAction(p1.getName(), new ChooseNobleAction("98"));
        assertThat(p1.getNobles()).extracting(Card::getId).containsExactly("98");
        assertThat(game.getCardFromId("99")).isNotNull();
        assertThat(game.getTurnCounter()).isEqualTo(1);

        // the second noble visits at the end of the player's next turn
        pass(game, p2);
        pass(game, p1);
        assertThat(p1.getNobles()).extracting(Card::getId).containsExactly("98", "99");
    }

    // ---------------------------------------------------------------- reserving with 10 tokens

    private static OrientGame gameWithTenTokens() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        game.getPlayerFromName("Player1").addTokens(tokens(TokenType.White, 2, TokenType.Blue, 2,
                TokenType.Green, 2, TokenType.Red, 2, TokenType.Brown, 2));
        return game;
    }

    @DisplayName("Reserving at 10 tokens without putBackToken reserves without gold (old payload)")
    @Test
    void testReserveAtTenWithoutPutBack() throws FileNotFoundException {
        OrientGame game = gameWithTenTokens();
        Player p1 = game.getPlayerFromName("Player1");

        assertThat(game.takeAction(p1.getName(), new ReserveCardAction("01"))).contains(ActionResult.VALID_ACTION);
        assertThat(p1.getReservedCards()).extracting(Card::getId).containsExactly("01");
        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(0);
        assertThat(game.getTokens().get(TokenType.Gold)).isEqualTo(5);
    }

    @DisplayName("Reserving at 10 tokens with putBackToken takes the gold and returns that token")
    @Test
    void testReserveAtTenWithPutBack() throws FileNotFoundException {
        OrientGame game = gameWithTenTokens();
        Player p1 = game.getPlayerFromName("Player1");

        assertThat(game.takeAction(p1.getName(), new ReserveCardAction("01", TokenType.Red)))
                .contains(ActionResult.VALID_ACTION);
        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(1);
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(1);
        assertThat(totalTokens(p1)).isEqualTo(10);
        assertThat(game.getTokens().get(TokenType.Gold)).isEqualTo(4);
        assertThat(game.getTokens().get(TokenType.Red)).isEqualTo(5);
    }

    @DisplayName("Reserving at 10 tokens may return the gold just taken")
    @Test
    void testReserveAtTenReturningGold() throws FileNotFoundException {
        OrientGame game = gameWithTenTokens();
        Player p1 = game.getPlayerFromName("Player1");

        assertThat(game.takeAction(p1.getName(), new ReserveCardAction("01", TokenType.Gold)))
                .contains(ActionResult.VALID_ACTION);
        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(0);
        assertThat(totalTokens(p1)).isEqualTo(10);
        assertThat(game.getTokens().get(TokenType.Gold)).isEqualTo(5);
        assertThat(p1.getReservedCards()).hasSize(1);
    }

    @DisplayName("putBackToken is refused when it is not needed or the token is not held")
    @Test
    void testReservePutBackRefused() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Red, 9));
        assertThat(game.takeAction(p1.getName(), new ReserveCardAction("01", TokenType.Red)))
                .containsExactly(ActionResult.PUT_BACK_NOT_ALLOWED);

        p1.addTokens(tokens(TokenType.White, 1));
        assertThat(game.takeAction(p1.getName(), new ReserveCardAction("01", TokenType.Blue)))
                .containsExactly(ActionResult.NOT_ENOUGH_TOKENS_IN_INVENTORY);
        assertThat(p1.getReservedCards()).isEmpty();
        assertThat(game.getCardFromId("01")).isNotNull();
    }

    // ---------------------------------------------------------------- Trading Posts

    @DisplayName("Trading Posts: points from a power unlocked this turn count for the end of the game")
    @Test
    void testTradingPostsPowerPointsCountForWin() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addPrestigePoints(7);
        p1.addNoble(new NobleCard(3, CostType.Bonus, tokens(TokenType.Red, 9), "test-noble"));
        p1.addBonus(TokenType.Green, 3);
        assertThat(p1.getPrestigePoints()).isEqualTo(10);

        // card 05 (two Green, covered by the Green bonuses) unlocks power 4: 5 points
        game.takeAction(p1.getName(), new BuyCardAction("05", new HashMap<>()));
        assertThat(p1.getPrestigePoints()).isEqualTo(15);
        assertThat(game.getPlayersWhoCanWin()).containsExactly(p1);

        pass(game, game.getPlayerFromName("Player2"));
        assertThat(game.isGameOver()).isTrue();
        assertThat(game.getWinner()).containsExactly(p1);
    }

    @DisplayName("Trading Posts: power 5 gives exactly one point per coat of arms placed")
    @Test
    void testTradingPostsPowerFiveCountsCoats() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");

        // power 5 (3 Brown) unlocks first: its own coat of arms is worth 1 point
        p1.addBonus(TokenType.Brown, 3);
        pass(game, p1);
        assertThat(p1.getPrestigePoints()).isEqualTo(1);
        pass(game, p2);

        // power 2 (2 White): one more coat of arms
        p1.addBonus(TokenType.White, 2);
        pass(game, p1);
        assertThat(p1.getPrestigePoints()).isEqualTo(2);
        pass(game, p2);

        // power 1 (3 Red, 1 White): one more
        p1.addBonus(TokenType.Red, 3);
        pass(game, p1);
        assertThat(p1.getPrestigePoints()).isEqualTo(3);
    }

    // ---------------------------------------------------------------- consistency

    @DisplayName("A rejected action leaves the game state exactly as it was")
    @Test
    void testRejectedActionsChangeNothing() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 2);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addTokens(tokens(TokenType.Red, 3, TokenType.Gold, 1));
        Map<TokenType, Integer> boardBefore = game.getTokens();
        Map<TokenType, Integer> playerBefore = p1.getTokens();

        game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 3)));
        game.takeAction(p1.getName(), new BuyCardAction("01", tokens(TokenType.Red, 3, TokenType.Gold, 2)));
        game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Red, 3), new HashMap<>()));
        game.takeAction(p1.getName(), new TakeTokenAction(tokens(TokenType.Red, 2, TokenType.Blue, 1),
                new HashMap<>()));
        game.takeAction("Player2", new TakeTokenAction(tokens(TokenType.Red, 1), new HashMap<>()));

        assertThat(game.getTokens()).isEqualTo(boardBefore);
        assertThat(p1.getTokens()).isEqualTo(playerBefore);
        assertThat(game.getTurnCounter()).isEqualTo(0);
        assertThat(game.getCurValidActions()).isEqualTo(MAIN_ACTIONS);
        assertThat(p1.getDevCards()).isEmpty();
    }
}
