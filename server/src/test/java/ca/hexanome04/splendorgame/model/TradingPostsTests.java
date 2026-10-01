package ca.hexanome04.splendorgame.model;

import ca.hexanome04.splendorgame.model.action.actions.*;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashMap;

import static org.assertj.core.api.AssertionsForClassTypes.assertThat;

/**
 * Tests for doing actions in a game.
 */
@ExtendWith(SpringExtension.class)
@SpringBootTest
public class TradingPostsTests {

    @DisplayName("Ensure power 1 makes you choose an extra token after card purchase")
    @Test
    void testPlayerGainExtraTokenAfterCardPurchasePower1() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.extraTokenAfterPurchase.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 1);
        p1.addTokens(tokensToAdd);

        game.takeAction(p1.getName(), new BuyCardAction("05", tokensToAdd));
        game.takeAction(p1.getName(), new TakeExtraTokenAfterPurchasePowerAction(TokenType.Green, null));

        tokensToAdd.put(TokenType.Red, 0);
        tokensToAdd.put(TokenType.Blue, 0);
        tokensToAdd.put(TokenType.Brown, 0);
        tokensToAdd.put(TokenType.Gold, 0);
        tokensToAdd.put(TokenType.Satchel, 0);
        tokensToAdd.put(TokenType.White, 0);

        assertThat(p1.getTokens()).isEqualTo(tokensToAdd);

    }

    @DisplayName("Ensure power 2 makes you choose an extra token after picking 2 of the same colour")
    @Test
    void testPlayerGainExtraTokenPower2() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.extraTokenAfterTakingSameColor.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 2);
        tokensToAdd.put(TokenType.Red, 1);


        game.takeAction(p1.getName(), new TakeTokenAction(tokensToAdd, new HashMap<>()));

        tokensToAdd.put(TokenType.Blue, 0);
        tokensToAdd.put(TokenType.Brown, 0);
        tokensToAdd.put(TokenType.Gold, 0);
        tokensToAdd.put(TokenType.Satchel, 0);
        tokensToAdd.put(TokenType.White, 0);

        assertThat(p1.getTokens()).isEqualTo(tokensToAdd);

    }

    @DisplayName("Ensure you can have unlocked Power 2 but not necessarily use it")
    @Test
    void testPlayerUnlockedPower2ButDoesNotUse() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.extraTokenAfterTakingSameColor.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 2);


        game.takeAction(p1.getName(), new TakeTokenAction(tokensToAdd, new HashMap<>()));

        tokensToAdd.put(TokenType.Red, 0);
        tokensToAdd.put(TokenType.Blue, 0);
        tokensToAdd.put(TokenType.Brown, 0);
        tokensToAdd.put(TokenType.Gold, 0);
        tokensToAdd.put(TokenType.Satchel, 0);
        tokensToAdd.put(TokenType.White, 0);

        assertThat(p1.getTokens()).isEqualTo(tokensToAdd);
    }

    @DisplayName("Ensure you cannot take an extra token with power 2 if there are not enough tokens left")
    @Test
    void testPlayerUnlockedPower2_TooFewTokensInBank() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.extraTokenAfterTakingSameColor.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 2);
        tokensToAdd.put(TokenType.Red, 1);

        HashMap<TokenType, Integer> tokensToRemove = new HashMap<>();
        tokensToAdd.put(TokenType.Red, 7);

        game.removeTokens(tokensToRemove);

        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new TakeTokenAction(tokensToAdd, new HashMap<>()));

        tokensToAdd.put(TokenType.Green, 0);
        tokensToAdd.put(TokenType.Red, 0);
        tokensToAdd.put(TokenType.Blue, 0);
        tokensToAdd.put(TokenType.Brown, 0);
        tokensToAdd.put(TokenType.Gold, 0);
        tokensToAdd.put(TokenType.Satchel, 0);
        tokensToAdd.put(TokenType.White, 0);

        assertThat(ActionResult.INVALID_TOKENS_GIVEN).isIn(result);
    }

    @DisplayName("Ensure you can buy a card using gold tokens with Power 3")
    @Test
    void testPlayerUsingPower3ToPayForCard() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.goldTokenWorthTwoTokens.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Gold, 1);
        tokensToAdd.put(TokenType.Blue, 1);
        tokensToAdd.put(TokenType.Brown, 1);

        p1.addTokens(tokensToAdd);

        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new BuyCardAction("02", tokensToAdd));

        assertThat(ActionResult.TURN_COMPLETED).isIn(result);
    }

    @DisplayName("Ensure power 3 makes one gold token pay for two gems of the same colour")
    @Test
    void testPlayerHavingPower3UnlockedButNotUsingIt() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        TradingPostsPlayer p1 = (TradingPostsPlayer) game.getPlayerFromName("Player1");

        p1.goldTokenWorthTwoTokens.unlockPower(p1);

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Gold, 2);
        tokensToAdd.put(TokenType.Blue, 1);
        tokensToAdd.put(TokenType.Brown, 1);

        p1.addTokens(tokensToAdd);

        // with power 3 a single gold pays for both missing red gems, so offering two is an overpayment
        ArrayList<ActionResult> rejected = game.takeAction(p1.getName(), new BuyCardAction("02", tokensToAdd));
        assertThat(ActionResult.PAYMENT_TOO_HIGH).isIn(rejected);

        HashMap<TokenType, Integer> exact = new HashMap<>(tokensToAdd);
        exact.put(TokenType.Gold, 1);
        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new BuyCardAction("02", exact));

        HashMap<TokenType, Integer> empty = new HashMap<>();
        empty.put(TokenType.Gold, 1);
        empty.put(TokenType.Blue, 0);
        empty.put(TokenType.Brown, 0);
        empty.put(TokenType.Red, 0);
        empty.put(TokenType.Green, 0);
        empty.put(TokenType.White, 0);
        empty.put(TokenType.Satchel, 0);

        assertThat(ActionResult.TURN_COMPLETED).isIn(result);
        assertThat(p1.getTokens()).isEqualTo(empty);
    }

    @DisplayName("Ensure power 4 (add 5 PP) works properly on acquisition of a card triggering gaining a noble")
    @Test
    void testPlayerGain5PPOnNobleAcquisition() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 1);
        p1.addTokens(tokensToAdd);
        p1.addBonus(TokenType.Blue, 2);
        p1.addBonus(TokenType.Red, 2);
        p1.addBonus(TokenType.Green, 3);


        // the Green bonuses already cover card 05, so the exact payment is nothing
        game.takeAction(p1.getName(), new BuyCardAction("05", new HashMap<>()));

        // only noble 99 qualifies, so it visits automatically and there is nothing to choose
        assertThat(p1.getNobles().size()).isEqualTo(1);
        ArrayList<ActionResult> result = game.takeAction(p1.getName(), new ChooseNobleAction("99"));
        assertThat(ActionResult.INVALID_PLAYER).isIn(result);

        // 8 because the power adds 5, the noble adds 3
        assertThat(p1.getPrestigePoints()).isEqualTo(8);
    }

    @DisplayName("Ensure power 4 (add 5 PP) works properly on acquisition of a noble then a card")
    @Test
    void testPlayerGain5PPOnCardAcquisition() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 1);
        p1.addTokens(tokensToAdd);
        p1.addBonus(TokenType.Green, 3);
        NobleCard c1 = (NobleCard) game.getCardFromId("99");
        p1.addNoble(c1);

        game.takeAction(p1.getName(), new BuyCardAction("05", new HashMap<>()));


        // 8 because the power adds 5, the noble adds 3
        assertThat(p1.getPrestigePoints()).isEqualTo(8);
    }

    @DisplayName("Ensure power 5 (add 1 PP per power unlocked) works properly when a power was unlocked in the same turn")
    @Test
    void testPlayerGainPPOnPower5UnlockWithOneOtherPower() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 1);
        p1.addTokens(tokensToAdd);
        p1.addBonus(TokenType.Green, 3);
        p1.addBonus(TokenType.Brown, 3);
        NobleCard c1 = (NobleCard) game.getCardFromId("99");
        p1.addNoble(c1);

        game.takeAction(p1.getName(), new BuyCardAction("05", new HashMap<>()));


        // 8 because power 4 adds 5, the noble adds 3, then power 5 adds 2 because there are 2 powers unlocked in total
        assertThat(p1.getPrestigePoints()).isEqualTo(10);
    }

    @DisplayName("Ensure power 5 (add 1 PP per power unlocked) works properly when unlocked alone")
    @Test
    void testPlayerGainPPOnPower5UnlockWithNoOtherPower() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 1);
        p1.addTokens(tokensToAdd);

        game.takeAction(p1.getName(), new BuyCardAction("08", tokensToAdd));


        // 1 because power 5 is unlocked on its own, so only 1 power
        assertThat(p1.getPrestigePoints()).isEqualTo(1);
    }

    @DisplayName("Ensure power 5 works when unlocked on some later turn after powers were unlocked")
    @Test
    void testPlayerGainPPOnPower5UnlockWithPowerUnlockedEarlierTurn() throws FileNotFoundException {
        TradingPostsGame game = GameUtils.createNewTradingPostGame(15, 2);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");
        Player p2 = game.getPlayerFromName("Player2");

        HashMap<TokenType, Integer> tokensToAdd = new HashMap<>();
        tokensToAdd.put(TokenType.Green, 3);
        p1.addTokens(tokensToAdd);

        HashMap<TokenType, Integer> tokensToUse = new HashMap<>();
        tokensToUse.put(TokenType.Green, 1);

        p1.addBonus(TokenType.Green, 3);
        NobleCard c1 = (NobleCard) game.getCardFromId("99");
        p1.addNoble(c1);

        // Unlocks power 4, adding 5PP to player (the Green bonuses cover the cost, so nothing is paid)
        game.takeAction(p1.getName(), new BuyCardAction("05", new HashMap<>()));

        // Increment turn back to player 1
        game.takeAction(p2.getName(), new TakeTokenAction(tokensToUse, new HashMap<>()));

        // Unlocks power 2
        game.takeAction(p1.getName(), new BuyCardAction("09", new HashMap<>()));

        game.takeAction(p2.getName(), new TakeTokenAction(tokensToUse, new HashMap<>()));

        // Unlocks power 5
        game.takeAction(p1.getName(), new BuyCardAction("08", new HashMap<>()));

        // 11 because 3 from noble, 5 from power 4 unlocked, 3 from power 5 unlocked and counting 3 powers
        assertThat(p1.getPrestigePoints()).isEqualTo(11);
    }

}
