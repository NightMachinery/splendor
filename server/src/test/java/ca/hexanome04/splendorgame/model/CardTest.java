package ca.hexanome04.splendorgame.model;

import java.io.FileNotFoundException;
import java.util.HashMap;

import static org.assertj.core.api.AssertionsForClassTypes.assertThat;
import static org.junit.jupiter.api.Assertions.*;

import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Test class for Card.
 * This class tests all applicable methods on all three types of card:
 * Noble, regular development, orient development.
 */
public class CardTest {

    // Dummy noble card used for testing.
    private NobleCard dummyNoble = new NobleCard(
            3,
            CostType.Bonus,
            new HashMap<>(){{
                put(TokenType.Green, 0);
                put(TokenType.White, 0);
                put(TokenType.Blue, 4);
                put(TokenType.Brown, 3);
                put(TokenType.Red, 4);
            }},
            "123"
    );

    // Dummy regular development card for testing.
    private RegDevelopmentCard dummyReg = new RegDevelopmentCard(
            CardTier.TIER_2,
            TokenType.Red,
            2,
            2,
            CostType.Token,
            new HashMap<>(){{
                put(TokenType.Green, 0);
                put(TokenType.White, 0);
                put(TokenType.Blue, 0);
                put(TokenType.Brown, 0);
                put(TokenType.Red, 4);
            }},
            "234"
    );

    // Dummy regular development card for testing.
    private OrientDevelopmentCard dummyOrient = new OrientDevelopmentCard(
            CardTier.TIER_2,
            TokenType.Red,
            2,
            CascadeType.Tier1,
            false,
            1,
            CostType.Token,
            new HashMap<>(){{
                put(TokenType.Green, 3);
                put(TokenType.White, 0);
                put(TokenType.Blue, 2);
                put(TokenType.Brown, 1);
                put(TokenType.Red, 1);
            }},
            "234", false
    );

    /**
     * Test the getCOstType method.
     */
    @DisplayName("Test the getCostType method.")
    @Test
    public void testGetCostType() {
        CostType costType = dummyNoble.getCostType();
        assertEquals(CostType.Bonus, costType);
    }

    /**
     * Test the getPrestigePoints method.
     */
    @DisplayName("Test the getPrestigePoints method.")
    @Test
    public void testGetPrestigePoints() {
        int prestige = dummyNoble.getPrestigePoints();
        assertEquals(3, prestige);
    }

    /**
     * Test the getReserveNoble method for OrientDevelopmentCard.
     */
    @DisplayName("Test the getReserveNoble method for OrientDevelopmentCard.")
    @Test
    public void testGetReserveNoble() {
        assertEquals(dummyOrient.getReserveNoble(), false);
    }

    /**
     * Test the isCascade method for OrientDevelopmentCard.
     */
    @DisplayName("Test the isCascade method for OrientDevelopmentCard.")
    @Test
    public void testIsCascade() {
        assertEquals(dummyOrient.isCascade(), true);
    }

    /**
     * Test the getCascadeType method for OrientDevelopmentCard.
     */
    @DisplayName("Test the getCascadeType method for OrientDevelopmentCard.")
    @Test
    public void testGetCascadeType() {
        assertEquals(dummyOrient.getCascadeType(), CascadeType.Tier1);
    }

    /**
     * Ensure isPurchasable correctly checks if player can purchase card.
     *
     * @throws FileNotFoundException Throws exception if loading from file fails
     */
    @DisplayName("Ensure isPurchasable correctly checks if player can purchase card.")
    @Test
    public void testIsPurchasable() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");
        p1.addBonus(TokenType.Red, 3);

        HashMap<TokenType, Integer> tokens = new HashMap<>();
        tokens.put(TokenType.Red, 1);
        p1.addTokens(tokens);

        // Make sure tokens added to player are successfully retrieved by getter
        assertThat(dummyReg.isPurchasable(p1, tokens)).isEqualTo(true);
    }

    /**
     * Ensure isPurchasable correctly checks if a player can purchase a card using their gold tokens.
     *
     * @throws FileNotFoundException Throws exception if loading from file fails
     */
    @DisplayName("Ensure isPurchasable correctly checks if player can purchase card with gold tokens.")
    @Test
    public void testIsPurchasableGoldTokens() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> tokens = new HashMap<>();
        tokens.put(TokenType.Gold, 4);
        p1.addTokens(tokens);

        // Make sure tokens added to player are successfully retrieved by getter
        assertThat(dummyReg.isPurchasable(p1, tokens)).isEqualTo(true);
    }


    /**
     * Ensure isPurchasable correctly checks if a player can purchase a card using their double gold tokens from orient.
     *
     * @throws FileNotFoundException Throws exception if loading from file fails
     */
    @DisplayName("Ensure isPurchasable correctly checks if player can purchase card with double gold tokens from orient.")
    @Test
    public void testIsPurchasableDoubleGoldToken() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");
        p1.addBonus(TokenType.Gold, 2);

        HashMap<TokenType, Integer> tokens = new HashMap<>();
        tokens.put(TokenType.Gold, 2);
        p1.addTokens(tokens);

        // checking a payment never changes the player; the purchase would use both gold bonuses of one card
        assertThat(dummyReg.isPurchasable(p1, tokens)).isEqualTo(true);
        assertThat(p1.getBonuses().get(TokenType.Gold)).isEqualTo(2);
        PaymentCheck check = dummyReg.checkPayment(p1, tokens);
        assertThat(check.goldBonusesToRemove()).isEqualTo(2);
        assertThat(check.goldCardsToDiscard()).isEqualTo(1);
    }


    /**
     * Ensure isPurchasable correctly checks if a player can purchase a card using their double gold bonuses.
     *
     * @throws FileNotFoundException Throws exception if loading from file fails
     */
    @DisplayName("Ensure that a player can waste a double gold token by using only 1 of the bonus gold tokens")
    @Test
    public void testIsPurchasableDoubleGoldTokensOddAmt() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");
        p1.addBonus(TokenType.Gold, 2);

        HashMap<TokenType, Integer> tokens = new HashMap<>();
        tokens.put(TokenType.Gold, 3);
        p1.addTokens(tokens);

        // only one of the two gold bonuses is needed, but the whole double gold card is discarded
        assertThat(dummyReg.isPurchasable(p1, tokens)).isEqualTo(true);
        assertThat(p1.getBonuses().get(TokenType.Gold)).isEqualTo(2);
        PaymentCheck check = dummyReg.checkPayment(p1, tokens);
        assertThat(check.goldBonusesToRemove()).isEqualTo(2);
        assertThat(check.goldCardsToDiscard()).isEqualTo(1);
    }

    /**
     * Ensure isPurchasable correctly checks if a player can purchase a card using their double gold bonuses.
     *
     * @throws FileNotFoundException Throws exception if loading from file fails
     */
    @DisplayName("Ensure that a player can waste a double gold token by using only 1 of the bonus gold tokens")
    @Test
    public void testIsPurchasableDoubleGoldTokensOddAmtByTradingPostPlayer() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewTradingPostGame(15, 4);

        // get first player (name = "Player1")
        Player p1 = game.getPlayerFromName("Player1");
        p1.addBonus(TokenType.Gold, 2);

        HashMap<TokenType, Integer> tokens = new HashMap<>();
        tokens.put(TokenType.Gold, 3);
        p1.addTokens(tokens);

        // only one of the two gold bonuses is needed, but the whole double gold card is discarded
        assertThat(dummyReg.isPurchasable(p1, tokens)).isEqualTo(true);
        assertThat(p1.getBonuses().get(TokenType.Gold)).isEqualTo(2);
        PaymentCheck check = dummyReg.checkPayment(p1, tokens);
        assertThat(check.goldBonusesToRemove()).isEqualTo(2);
        assertThat(check.goldCardsToDiscard()).isEqualTo(1);
    }

    @DisplayName("Ensure overpaying for a card is rejected and checking a payment changes nothing.")
    @Test
    public void testCheckPaymentRejectsOverpayment() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);
        Player p1 = game.getPlayerFromName("Player1");

        HashMap<TokenType, Integer> owned = new HashMap<>();
        owned.put(TokenType.Red, 5);
        owned.put(TokenType.Gold, 2);
        owned.put(TokenType.Blue, 1);
        p1.addTokens(owned);

        HashMap<TokenType, Integer> tooManyRed = new HashMap<>();
        tooManyRed.put(TokenType.Red, 5);
        assertThat(dummyReg.checkPayment(p1, tooManyRed).result()).isEqualTo(ActionResult.PAYMENT_TOO_HIGH);

        HashMap<TokenType, Integer> unneededBlue = new HashMap<>();
        unneededBlue.put(TokenType.Red, 4);
        unneededBlue.put(TokenType.Blue, 1);
        assertThat(dummyReg.checkPayment(p1, unneededBlue).result()).isEqualTo(ActionResult.PAYMENT_TOO_HIGH);

        HashMap<TokenType, Integer> extraGold = new HashMap<>();
        extraGold.put(TokenType.Red, 3);
        extraGold.put(TokenType.Gold, 2);
        assertThat(dummyReg.checkPayment(p1, extraGold).result()).isEqualTo(ActionResult.PAYMENT_TOO_HIGH);

        HashMap<TokenType, Integer> tooLittle = new HashMap<>();
        tooLittle.put(TokenType.Red, 3);
        assertThat(dummyReg.checkPayment(p1, tooLittle).result()).isEqualTo(ActionResult.PAYMENT_TOO_LOW);

        HashMap<TokenType, Integer> exact = new HashMap<>();
        exact.put(TokenType.Red, 3);
        exact.put(TokenType.Gold, 1);
        assertThat(dummyReg.checkPayment(p1, exact).isValid()).isTrue();

        HashMap<TokenType, Integer> negative = new HashMap<>();
        negative.put(TokenType.Red, 5);
        negative.put(TokenType.Blue, -1);
        assertThat(dummyReg.checkPayment(p1, negative).result()).isEqualTo(ActionResult.INVALID_TOKENS_GIVEN);

        // nothing changed
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(5);
        assertThat(p1.getTokens().get(TokenType.Gold)).isEqualTo(2);
    }

    @DisplayName("Ensure bonuses reduce the exact payment, so nothing is owed for a fully covered colour.")
    @Test
    public void testCheckPaymentWithBonuses() throws FileNotFoundException {
        OrientGame game = GameUtils.createNewOrientGame(15, 4);
        Player p1 = game.getPlayerFromName("Player1");
        p1.addBonus(TokenType.Red, 3);

        HashMap<TokenType, Integer> owned = new HashMap<>();
        owned.put(TokenType.Red, 2);
        p1.addTokens(owned);

        HashMap<TokenType, Integer> one = new HashMap<>();
        one.put(TokenType.Red, 1);
        assertThat(dummyReg.checkPayment(p1, one).isValid()).isTrue();
        assertThat(dummyReg.checkPayment(p1, owned).result()).isEqualTo(ActionResult.PAYMENT_TOO_HIGH);
        assertThat(dummyReg.checkPayment(p1, new HashMap<>()).result()).isEqualTo(ActionResult.PAYMENT_TOO_LOW);
    }

}
