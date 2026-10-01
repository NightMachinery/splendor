package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.Card;
import ca.hexanome04.splendorgame.model.DevelopmentCard;
import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.SplendorException;
import ca.hexanome04.splendorgame.model.TokenType;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionJson;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Perform the reserve card action.
 */
public class ReserveCardAction extends Action {

    private String reserveCardId;
    private TokenType putBackToken;

    /**
     * Construct a reserve card action.
     *
     * @param reserveCardId card id to be reserved from game
     */
    public ReserveCardAction(String reserveCardId) {
        this(reserveCardId, null);
    }

    /**
     * Construct a reserve card action that returns a token, for a player who already holds 10 tokens.
     *
     * @param reserveCardId card id to be reserved from game
     * @param putBackToken token to return so that taking the gold keeps the player at 10 tokens (may be null)
     */
    public ReserveCardAction(String reserveCardId, TokenType putBackToken) {
        super(Actions.RESERVE_CARD);
        this.reserveCardId = reserveCardId;
        this.putBackToken = putBackToken;
    }

    /**
     * Construct a reserve card action (to be filled with info from decoder).
     */
    public ReserveCardAction() {
        this("");
    }

    @Override
    protected List<ActionResult> run(Game game, Player player) {

        ArrayList<ActionResult> result = new ArrayList<>();

        // get card from board (ids of nobles or cities are not development cards)
        Card boardCard = game.getCardFromId(this.reserveCardId);
        if (!(boardCard instanceof DevelopmentCard dc)) {
            throw new SplendorException("Card with id '" + this.reserveCardId
                    + "' is not a development card on the board.");
        }

        if (player.getReservedCards().size() >= 3) {
            result.add(ActionResult.MAXIMUM_CARDS_RESERVED);
            return result;
        }

        int playerTokenCount = 0;
        for (Map.Entry<TokenType, Integer> entry : player.getTokens().entrySet()) {
            playerTokenCount += entry.getValue();
        }
        boolean goldAvailable = game.getTokens().getOrDefault(TokenType.Gold, 0) > 0;

        // official rule: you take the gold and, if that makes 11 tokens, return one (it may be the gold itself);
        // without a putBackToken a player at 10 tokens simply reserves without taking gold
        if (putBackToken != null) {
            if (putBackToken == TokenType.Satchel) {
                result.add(ActionResult.INVALID_TOKENS_GIVEN);
                return result;
            }
            if (!goldAvailable || playerTokenCount < 10) {
                result.add(ActionResult.PUT_BACK_NOT_ALLOWED);
                return result;
            }
            if (putBackToken != TokenType.Gold && player.getTokens().getOrDefault(putBackToken, 0) < 1) {
                result.add(ActionResult.NOT_ENOUGH_TOKENS_IN_INVENTORY);
                return result;
            }
        }

        game.takeCard(dc);
        player.reserveCard(dc);

        if (goldAvailable && (playerTokenCount < 10 || putBackToken != null)) {
            HashMap<TokenType, Integer> goldToken = new HashMap<>();
            goldToken.put(TokenType.Gold, 1);
            game.removeTokens(goldToken);
            player.addTokens(goldToken);

            if (putBackToken != null) {
                HashMap<TokenType, Integer> returned = new HashMap<>();
                returned.put(putBackToken, 1);
                player.removeTokens(returned);
                game.addTokens(returned);
            }
        }

        if (game.getCurValidActions().contains(Actions.RESERVE_CARD)) {
            result.add(ActionResult.VALID_ACTION);
        }
        result.add(ActionResult.TURN_COMPLETED);

        // clear list of current player valid actions
        game.clearValidActions();

        return result;
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.reserveCardId = ActionJson.requireString(jobj, "cardId");
        // optional, see run()
        this.putBackToken = ActionJson.optionalTokenType(jobj, "putBackToken");
        return this;

    }

}
