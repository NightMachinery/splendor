package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionJson;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import com.google.gson.JsonObject;
import java.util.*;

/**
 * Perform the buy card action.
 */
public class BuyCardAction extends Action {

    private String buyCardId;
    private HashMap<TokenType, Integer> selectedTokens;

    /**
     * Construct a buy card action.
     *
     * @param buyCardId card id to be bought from game
     * @param selectedTokens tokens that are used to buy the card
     */
    public BuyCardAction(String buyCardId, HashMap<TokenType, Integer> selectedTokens) {
        super(Actions.BUY_CARD);
        this.buyCardId = buyCardId;
        this.selectedTokens = selectedTokens == null ? new HashMap<>() : selectedTokens;
    }

    /**
     * Construct a buy card action (to be filled with info from decoder).
     */
    public BuyCardAction() {
        this("", new HashMap<>());
    }

    @Override
    protected List<ActionResult> run(Game game, Player player) {

        // get card from board (ids of nobles or cities are not development cards)
        Card boardCard = game.getCardFromId(this.buyCardId);
        DevelopmentCard dc = boardCard instanceof DevelopmentCard d ? d : null;

        // try reserved
        boolean wasReserved = false;
        if (dc == null) {
            dc = player.getReservedDevelopmentCard(this.buyCardId);
            wasReserved = dc != null;
        }

        if (dc == null) {
            throw new SplendorException("Card with id '" + this.buyCardId
                    + "' is neither a development card on the board nor one of your reserved cards.");
        }

        // for orient, can only buy satchel if you own another card with a bonus
        if (dc.getTokenType() == TokenType.Satchel && !OrientGame.ownsGemBonusCard(player)) {
            throw new SplendorException("Cannot purchase card with satchel bonus "
                    + "without having another purchased card with a bonus.");
        }

        ArrayList<ActionResult> result = new ArrayList<>();

        // check the payment without touching any state, so a rejected buy changes nothing
        PaymentCheck payment = dc.checkPayment(player, selectedTokens);
        if (!payment.isValid()) {
            result.add(payment.result());
            return result;
        }

        // pay
        player.removeTokens(selectedTokens);
        game.addTokens(selectedTokens);
        discardGoldCards(player, payment);
        // a sacrifice (bonus cost) discards cards the player already owned, never the card being bought
        if (dc.getCostType() == CostType.Bonus) {
            player.burnBonuses(dc.getTokenCost());
        }

        player.addCard(dc);
        if (wasReserved) {
            player.removeReservedCard(dc);
        } else {
            game.takeCard(dc);
        }

        if (dc.getTokenType() != TokenType.Satchel) {
            player.addBonus(dc.getTokenType(), dc.getBonus());
        }
        player.addPrestigePoints(dc.getPrestigePoints());

        if (game instanceof OrientGame og) {
            result.addAll(og.followUpsForAcquiredCard(player, dc));
        }

        // Take extra token if player has unlocked power 1
        if (player instanceof TradingPostsPlayer tpp && tpp.extraTokenAfterPurchase.isUnlocked()) {
            result.add(ActionResult.MUST_TAKE_EXTRA_TOKEN_AFTER_PURCHASE);
        }

        if (result.size() == 0) {
            result.add(ActionResult.TURN_COMPLETED);
        }

        if (game.getCurValidActions().contains(Actions.BUY_CARD)) {
            result.add(ActionResult.VALID_ACTION);
        }

        // clear list of current player valid actions
        game.clearValidActions();

        return result;
    }

    /**
     * Remove the gold bonuses used by the payment and discard the double gold cards they came from.
     *
     * @param player buyer
     * @param payment checked payment
     */
    private static void discardGoldCards(Player player, PaymentCheck payment) {
        if (payment.goldBonusesToRemove() > 0) {
            HashMap<TokenType, Integer> goldBonuses = new HashMap<>();
            goldBonuses.put(TokenType.Gold, payment.goldBonusesToRemove());
            player.removeBonuses(goldBonuses);
        }
        for (int i = 0; i < payment.goldCardsToDiscard(); i++) {
            for (DevelopmentCard c : player.getDevCards()) {
                if (c.getTokenType() == TokenType.Gold) {
                    player.removeCard(c);
                    break;
                }
            }
        }
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.buyCardId = ActionJson.requireString(jobj, "cardId");
        this.selectedTokens = ActionJson.tokenAmounts(jobj, "tokens", true);
        return this;
    }

}
