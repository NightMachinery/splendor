package ca.hexanome04.splendorgame.model;

import ca.hexanome04.splendorgame.model.action.ActionResult;

/**
 * Outcome of checking a proposed payment for a development card.
 * Computing it never changes the player or the board; the buy action applies it afterwards.
 *
 * @param result VALID_ACTION when the payment is acceptable, otherwise the reason it is rejected
 * @param goldBonusesToRemove gold bonuses (from double gold cards) that the purchase uses up
 * @param goldCardsToDiscard double gold cards the player has to discard because their bonus was used
 */
public record PaymentCheck(ActionResult result, int goldBonusesToRemove, int goldCardsToDiscard) {

    /**
     * Create a rejected payment.
     *
     * @param reason why the payment is rejected
     * @return rejected payment check
     */
    public static PaymentCheck rejected(ActionResult reason) {
        return new PaymentCheck(reason, 0, 0);
    }

    /**
     * Whether the payment is acceptable.
     *
     * @return true if the card can be bought with this payment
     */
    public boolean isValid() {
        return result == ActionResult.VALID_ACTION;
    }
}
