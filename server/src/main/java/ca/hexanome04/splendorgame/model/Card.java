package ca.hexanome04.splendorgame.model;

import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import java.util.HashMap;
import java.util.Map;

/**
 * Class representing a Card object.
 */
public abstract class Card {

    private final String id;
    private final int prestigePoints;
    private final CostType costType;
    private final HashMap<TokenType, Integer> tokenCost;

    // maybe attribute for the actual image of the card to be added?
    // add an attribute for a list of tokens representing the token/bonus cost for this card

    /**
     * Creates a new card with provided prestige point amount, cost type and card type.
     *
     * @param prestigePoints Amount of prestige points associated to this card.
     * @param costType       Cost type associated to this card.
     * @param tokenCost      Token cost associated to this card.
     * @param id             ID Associated to this card.
     */
    public Card(int prestigePoints, CostType costType, HashMap<TokenType, Integer> tokenCost, String id) {
        this.prestigePoints = prestigePoints;
        this.costType = costType;
        this.tokenCost = tokenCost;
        this.id = id;
    }

    /**
     * Get the cost type of this card (tokens or bonuses).
     *
     * @return The cost type of the card.
     */
    public CostType getCostType() {
        return costType;
    }

    /**
     * Get the number of prestige points associated to this card.
     *
     * @return The number of prestige points.
     */
    public int getPrestigePoints() {
        return prestigePoints;
    }

    /**
     * Returns the cost (in tokens) of the Card.
     *
     * @return Returns new list of TokenTypes.
     */
    public HashMap<TokenType, Integer> getTokenCost() {
        return new HashMap<TokenType, Integer>(tokenCost);
    }

    /**
     * Get ID of this card.
     *
     * @return id of card
     */
    public String getId() {
        return this.id;
    }

    /**
     * Check if this card can be purchased by the player with exactly the given tokens.
     * This never changes the player's state.
     *
     * @param player player that wants to purchase this card
     * @param tokensToUse tokens requested to use
     * @return true if the payment covers the cost exactly
     */
    public boolean isPurchasable(Player player, HashMap<TokenType, Integer> tokensToUse) {
        return checkPayment(player, tokensToUse).isValid();
    }

    /**
     * Check a proposed payment for this card without changing any state.
     *
     * <p>Rules: bonuses reduce the cost of their colour; each gem token pays one gem of its own colour;
     * gold tokens pay for any remaining gems (each gold covers two gems of one colour once the Trading Posts
     * gold power is unlocked); whatever is still missing after that is covered by gold bonuses from double gold
     * cards, and a double gold card is discarded as soon as one of its two bonuses is used. The payment must be
     * exact: offering a gem the card does not need, or more gold than the remaining cost, is rejected. Cards
     * paid with bonuses (cost type Bonus) take no tokens at all.</p>
     *
     * @param player player that wants to purchase this card
     * @param tokensToUse tokens offered as payment (may be null or empty)
     * @return the outcome of the check
     */
    public PaymentCheck checkPayment(Player player, Map<TokenType, Integer> tokensToUse) {
        HashMap<TokenType, Integer> offered = new HashMap<>();
        if (tokensToUse != null) {
            offered.putAll(tokensToUse);
        }
        for (Map.Entry<TokenType, Integer> entry : offered.entrySet()) {
            if (entry.getValue() == null || entry.getValue() < 0) {
                return PaymentCheck.rejected(ActionResult.INVALID_TOKENS_GIVEN);
            }
            if (entry.getKey() == TokenType.Satchel && entry.getValue() > 0) {
                return PaymentCheck.rejected(ActionResult.INVALID_TOKENS_GIVEN);
            }
        }

        if (!player.hasTokens(offered)) {
            return PaymentCheck.rejected(ActionResult.NOT_ENOUGH_TOKENS_IN_INVENTORY);
        }

        Map<TokenType, Integer> bonuses = player.getBonuses();

        if (this.costType == CostType.Bonus) {
            int tokensOffered = offered.values().stream().mapToInt(Integer::intValue).sum();
            if (tokensOffered > 0) {
                return PaymentCheck.rejected(ActionResult.PAYMENT_TOO_HIGH);
            }
            for (TokenType type : TokenType.values()) {
                if (type.isGem() && amount(this.tokenCost, type) > amount(bonuses, type)) {
                    return PaymentCheck.rejected(ActionResult.NOT_ENOUGH_BONUSES);
                }
            }
            return new PaymentCheck(ActionResult.VALID_ACTION, 0, 0);
        }

        // how many gems one gold token (or one gold bonus) pays for
        int goldValue = player instanceof TradingPostsPlayer tpp && tpp.goldTokenWorthTwoTokens.isUnlocked() ? 2 : 1;

        // gold needed for what the gem tokens leave unpaid (gold always pays gems of a single colour)
        int goldNeeded = 0;
        for (TokenType type : TokenType.values()) {
            if (!type.isGem()) {
                continue;
            }
            int stillOwed = Math.max(0, amount(this.tokenCost, type) - amount(bonuses, type));
            int paid = amount(offered, type);
            if (paid > stillOwed) {
                return PaymentCheck.rejected(ActionResult.PAYMENT_TOO_HIGH);
            }
            int deficit = stillOwed - paid;
            goldNeeded += (deficit + goldValue - 1) / goldValue;
        }

        int goldOffered = amount(offered, TokenType.Gold);
        if (goldOffered > goldNeeded) {
            return PaymentCheck.rejected(ActionResult.PAYMENT_TOO_HIGH);
        }

        int goldBonusesUsed = goldNeeded - goldOffered;
        int goldBonusesOwned = amount(bonuses, TokenType.Gold);
        if (goldBonusesUsed > goldBonusesOwned) {
            return PaymentCheck.rejected(ActionResult.PAYMENT_TOO_LOW);
        }

        // each double gold card holds two gold bonuses and is discarded as a whole once used
        int goldCardsToDiscard = (goldBonusesUsed + 1) / 2;
        int goldBonusesToRemove = Math.min(goldBonusesOwned, goldCardsToDiscard * 2);
        return new PaymentCheck(ActionResult.VALID_ACTION, goldBonusesToRemove, goldCardsToDiscard);
    }

    private static int amount(Map<TokenType, Integer> map, TokenType type) {
        Integer value = map.get(type);
        return value == null ? 0 : value;
    }

}
