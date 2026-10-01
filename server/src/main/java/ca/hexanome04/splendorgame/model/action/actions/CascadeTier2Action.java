package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.CardTier;
import ca.hexanome04.splendorgame.model.action.Actions;

/**
 * Perform the tier 2 cascade action (take a tier 2 card for free).
 */
public class CascadeTier2Action extends CascadeAction {

    /**
     * Construct a cascade action.
     *
     * @param buyCardId card id to be taken from the board
     */
    public CascadeTier2Action(String buyCardId) {
        super(buyCardId, Actions.CASCADE_2, CardTier.TIER_2);
    }

    /**
     * Construct a cascade action (to be filled with info from decoder).
     */
    public CascadeTier2Action() {
        this("");
    }

}
