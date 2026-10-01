package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.Player;
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

/**
 * Perform power 1 after purchasing a development card.
 */
public class TakeExtraTokenAfterPurchasePowerAction extends Action {

    private TokenType takeToken;
    private TokenType putBackToken;

    /**
     * Construct a take token action for power 1.
     *
     * @param takeToken    token to be taken by player
     * @param putBackToken token to be put back by player
     */
    public TakeExtraTokenAfterPurchasePowerAction(
            TokenType takeToken, TokenType putBackToken) {
        super(Actions.TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER);
        this.takeToken = takeToken;
        this.putBackToken = putBackToken;
    }

    /**
     * Construct a take token action for power 1 (to be filled with info from decoder).
     */
    public TakeExtraTokenAfterPurchasePowerAction() {
        this(null, null);
    }

    @Override
    protected List<ActionResult> run(Game game, Player player) {

        ArrayList<ActionResult> result = new ArrayList<>();

        if (takeToken != null && !takeToken.isGem()) {
            result.add(ActionResult.GOLD_CANNOT_BE_TAKEN);
            return result;
        }
        if (putBackToken == TokenType.Satchel) {
            result.add(ActionResult.INVALID_TOKENS_GIVEN);
            return result;
        }

        // skipping the extra token is allowed
        if (takeToken == null && putBackToken == null) {
            return completed(game, result);
        }
        if (takeToken == null) {
            result.add(ActionResult.PUT_BACK_NOT_ALLOWED);
            return result;
        }

        int onBoard = game.getTokens().getOrDefault(takeToken, 0);
        if (onBoard < 1) {
            result.add(ActionResult.NOT_ENOUGH_TOKENS_ON_BOARD);
            return result;
        }

        int playerTotalTokens = 1;
        for (Integer amount : player.getTokens().values()) {
            playerTotalTokens += amount == null ? 0 : amount;
        }

        HashMap<TokenType, Integer> takeTokens = new HashMap<>();
        takeTokens.put(takeToken, 1);
        HashMap<TokenType, Integer> putBackTokens = new HashMap<>();

        if (putBackToken != null) {
            if (playerTotalTokens <= 10) {
                result.add(ActionResult.TOO_MANY_TOKENS_RETURNED);
                return result;
            }
            int held = player.getTokens().getOrDefault(putBackToken, 0) + (putBackToken == takeToken ? 1 : 0);
            if (held < 1) {
                result.add(ActionResult.NOT_ENOUGH_TOKENS_IN_INVENTORY);
                return result;
            }
            putBackTokens.put(putBackToken, 1);
            playerTotalTokens--;
        }

        if (playerTotalTokens > 10) {
            result.add(ActionResult.MAXIMUM_TOKENS_IN_INVENTORY);
            return result;
        }

        game.removeTokens(takeTokens);
        game.addTokens(putBackTokens);
        player.takeTokens(takeTokens, putBackTokens);

        return completed(game, result);
    }

    private static List<ActionResult> completed(Game game, List<ActionResult> result) {
        result.add(ActionResult.VALID_ACTION);
        result.add(ActionResult.TURN_COMPLETED);
        game.removeValidAction(Actions.TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER);
        return result;
    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.takeToken = ActionJson.optionalTokenType(jobj, "takeToken");
        this.putBackToken = ActionJson.optionalTokenType(jobj, "putBackToken");
        return this;
    }

}
