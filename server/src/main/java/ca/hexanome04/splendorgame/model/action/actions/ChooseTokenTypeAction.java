package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.DevelopmentCard;
import ca.hexanome04.splendorgame.model.OrientDevelopmentCard;
import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.SplendorException;
import ca.hexanome04.splendorgame.model.TokenType;
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
 * Perform the choose token type for satchel action.
 */

public class ChooseTokenTypeAction extends Action {

    private String cardId;
    private TokenType assignedTokenType;


    /**
     * Construct a choose token type action.
     *
     * @param cardId card id to have its token assigned
     * @param assignedTokenType token type to use for assignment
     */
    public ChooseTokenTypeAction(String cardId, TokenType assignedTokenType) {
        super(Actions.CHOOSE_SATCHEL_TOKEN);
        this.cardId = cardId;
        this.assignedTokenType = assignedTokenType;
    }

    /**
     * Construct a choose token action (to be filled with info from decoder).
     */
    public ChooseTokenTypeAction() {
        this("", null);
    }

    @Override
    protected List<ActionResult> run(Game game, Player p) {


        ArrayList<ActionResult> result = new ArrayList<>();

        DevelopmentCard devCard = p.getPurchasedDevelopmentCard(this.cardId);
        if (!(devCard instanceof OrientDevelopmentCard orientDevCard)) {
            throw new SplendorException("Card with id '" + this.cardId + "' does not exist is not of type Satchel.");
        }

        if (orientDevCard.getTokenType() != TokenType.Satchel) {
            throw new SplendorException("Card with id '" + this.cardId + "' is not of type Satchel.");
        }

        if (this.assignedTokenType == null || !this.assignedTokenType.isGem()) {
            result.add(ActionResult.INVALID_TOKEN_CHOSEN);
            return result;
        }

        // player can only set satchel token type to another bonus they already have
        boolean valid = false;
        for (DevelopmentCard c : p.getDevCards()) {
            if (c.getTokenType() != null && c.getTokenType() != TokenType.Satchel
                    && c.getTokenType() != TokenType.Gold
                    && c.getTokenType() == this.assignedTokenType) {
                valid = true;
                break;
            }
        }
        if (!valid) {
            result.add(ActionResult.INVALID_TOKEN_CHOSEN);
            return result;
        }

        // add bonus to player
        orientDevCard.setTokenType(assignedTokenType);
        p.addBonus(assignedTokenType, 1);
        result.add(ActionResult.TURN_COMPLETED);


        if (game.getCurValidActions().contains(Actions.CHOOSE_SATCHEL_TOKEN)) {
            result.add(ActionResult.VALID_ACTION);
        }

        // a second satchel taken in the same turn (through a cascade) still needs its colour
        if (!OrientGame.hasUnassignedSatchel(p)) {
            game.removeValidAction(Actions.CHOOSE_SATCHEL_TOKEN);
        }

        return result;

    }

    @Override
    public Action decodeAction(JsonObject jobj) {

        this.cardId = ActionJson.requireString(jobj, "cardId");
        this.assignedTokenType = ActionJson.requireTokenType(jobj, "selected");

        return this;
    }
}