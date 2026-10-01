package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.SplendorException;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionJson;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesPlayer;
import ca.hexanome04.splendorgame.model.gameversions.cities.CityCard;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Perform the choose city action (in case when player qualifies for >1 city in one turn).
 */
public class ChooseCityAction extends Action {

    private String cityId;

    /**
     * Construct an action with the given action type.
     *
     * @param cityId id of the chosen city card
     */
    public ChooseCityAction(String cityId) {
        super(Actions.CHOOSE_CITY);
        this.cityId = cityId;
    }

    /**
     * Construct a choose city action (to be filled with info from decoder).
     */
    public ChooseCityAction() {
        this("");
    }

    @Override
    protected List<ActionResult> run(Game game, Player p) {

        ArrayList<ActionResult> result = new ArrayList<>();

        if (!(game instanceof CitiesGame cgame) || !(p instanceof CitiesPlayer cplayer)) {
            throw new SplendorException("This game has no cities.");
        }

        if (!(cgame.getCardFromId(this.cityId) instanceof CityCard cc)) {
            throw new SplendorException("City card with id '" + this.cityId + "' is not on the board.");
        }

        if (!cgame.qualifiesCities(cplayer).contains(cc)) {
            throw new SplendorException("City card with id '" + this.cityId + "' cannot be chosen: you do not qualify for it.");
        }
        cgame.takeCard(cc);
        cplayer.addCity(cc);

        if (cgame.getCurValidActions().contains(Actions.CHOOSE_CITY)) {
            result.add(ActionResult.VALID_ACTION);
        }
        result.add(ActionResult.TURN_COMPLETED);
        cgame.removeValidAction(Actions.CHOOSE_CITY);

        return result;
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.cityId = ActionJson.requireString(jobj, "cityId");
        return this;
    }
}
