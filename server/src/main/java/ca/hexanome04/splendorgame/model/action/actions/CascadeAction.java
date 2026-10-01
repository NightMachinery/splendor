package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionJson;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Perform the cascade action: take a visible development card of a given tier for free.
 * The card may come from the regular row or the Orient row of that tier, but not from reserved cards.
 */
public abstract class CascadeAction extends Action {

    private final Actions cascadeType;
    private final CardTier tier;
    private String cascadeCardId;

    /**
     * Construct a cascade action.
     *
     * @param buyCardId card id to be taken from the board
     * @param cascadeType the action identifier (CASCADE_1 or CASCADE_2)
     * @param tier the tier of card this cascade takes
     */
    protected CascadeAction(String buyCardId, Actions cascadeType, CardTier tier) {
        super(cascadeType);
        this.cascadeType = cascadeType;
        this.tier = tier;
        this.cascadeCardId = buyCardId;
    }

    @Override
    protected List<ActionResult> run(Game game, Player player) {

        Card card = game.getCardFromId(this.cascadeCardId);
        if (!(card instanceof DevelopmentCard dc)) {
            throw new SplendorException("Card with id '" + this.cascadeCardId
                    + "' is not a development card on the board.");
        }
        if (dc.getCardTier() != tier) {
            throw new SplendorException(cascadeType + " takes a " + describe(tier) + " card, but card '"
                    + this.cascadeCardId + "' is a " + describe(dc.getCardTier()) + " card.");
        }
        OrientGame og = (OrientGame) game;
        if (!og.getCascadeChoices(player, tier).contains(dc)) {
            throw new SplendorException("Card '" + this.cascadeCardId + "' cannot be taken: a Satchel card "
                    + "needs another card with a gem bonus.");
        }

        player.addCard(dc);
        game.takeCard(dc);

        if (dc.getTokenType() != TokenType.Satchel) {
            player.addBonus(dc.getTokenType(), dc.getBonus());
        }
        player.addPrestigePoints(dc.getPrestigePoints());

        ArrayList<ActionResult> result = new ArrayList<>(og.followUpsForAcquiredCard(player, dc));

        if (game.getCurValidActions().contains(cascadeType)) {
            result.add(ActionResult.VALID_ACTION);
        }
        result.add(ActionResult.TURN_COMPLETED);

        game.removeValidAction(cascadeType);

        return result;
    }

    private static String describe(CardTier cardTier) {
        return switch (cardTier) {
            case TIER_1 -> "tier 1";
            case TIER_2 -> "tier 2";
            case TIER_3 -> "tier 3";
        };
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.cascadeCardId = ActionJson.requireString(jobj, "cardId");
        return this;
    }

}
