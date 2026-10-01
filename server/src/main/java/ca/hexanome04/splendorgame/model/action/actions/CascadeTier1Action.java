package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.CardTier;
import ca.hexanome04.splendorgame.model.action.Actions;

/**
 * Perform the tier 1 cascade action (take a tier 1 card for free).
 */
public class CascadeTier1Action extends CascadeAction {

    /**
     * Construct a cascade action.
     *
     * @param buyCardId card id to be taken from the board
     */
    public CascadeTier1Action(String buyCardId) {
        super(buyCardId, Actions.CASCADE_1, CardTier.TIER_1);
    }

    /**
     * Construct a cascade action (to be filled with info from decoder).
     */
    public CascadeTier1Action() {
        this("");
    }

}
