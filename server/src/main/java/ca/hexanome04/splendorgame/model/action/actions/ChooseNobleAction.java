package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.NobleCard;
import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.SplendorException;
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
 * Perform the choose noble action (in case when player qualifies for >1 noble in one turn).
 */
public class ChooseNobleAction extends Action {

    private String nobleId;

    /**
     * Construct a choose noble action.
     *
     * @param nobleId id of chosen noble.
     */
    public ChooseNobleAction(String nobleId) {
        super(Actions.CHOOSE_NOBLE);
        this.nobleId = nobleId;
    }

    /**
     * Construct a choose noble action (to be filled with info from decoder).
     */
    public ChooseNobleAction() {
        this("");
    }

    @Override
    protected List<ActionResult> run(Game game, Player p) {

        ArrayList<ActionResult> result = new ArrayList<>();
        OrientGame og = (OrientGame) game;

        // get list of noble card ids that player can actually get (board and own reserved nobles)
        NobleCard nc = null;
        for (NobleCard nobleCard : og.qualifiesForNoble(p)) {
            if (nobleCard.getId().equals(nobleId)) {
                nc = nobleCard;
                break;
            }
        }

        if (nc == null) {
            throw new SplendorException("Noble card with id '" + this.nobleId + "' does not exist or you do not qualify for it.");
        }

        og.grantNoble(p, nc);

        if (game.getCurValidActions().contains(Actions.CHOOSE_NOBLE)) {
            result.add(ActionResult.VALID_ACTION);
        }
        result.add(ActionResult.TURN_COMPLETED);

        game.removeValidAction(Actions.CHOOSE_NOBLE);

        return result;
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.nobleId = ActionJson.requireString(jobj, "cardId");
        return this;
    }
}
