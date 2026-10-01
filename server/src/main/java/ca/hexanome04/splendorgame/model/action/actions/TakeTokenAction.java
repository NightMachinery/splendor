package ca.hexanome04.splendorgame.model.action.actions;

import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.TokenType;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionJson;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Perform the take token action.
 */
public class TakeTokenAction extends Action {

    private HashMap<TokenType, Integer> takeTokens;
    private HashMap<TokenType, Integer> putBackTokens;

    Logger logger = LoggerFactory.getLogger(TakeTokenAction.class);

    /**
     * Construct a take token action.
     *
     * @param takeTokens    tokens to be taken by player
     * @param putBackTokens tokens to be put back by player
     */
    public TakeTokenAction(HashMap<TokenType, Integer> takeTokens, HashMap<TokenType, Integer> putBackTokens) {
        super(Actions.TAKE_TOKEN);
        this.takeTokens = takeTokens == null ? new HashMap<>() : takeTokens;
        this.putBackTokens = putBackTokens == null ? new HashMap<>() : putBackTokens;
    }

    /**
     * Construct a take token action (to be filled with info from decoder).
     */
    public TakeTokenAction() {
        this(new HashMap<>(), new HashMap<>());
    }

    @Override
    protected List<ActionResult> run(Game game, Player player) {

        ArrayList<ActionResult> result = new ArrayList<>();

        for (Map.Entry<TokenType, Integer> entry : takeTokens.entrySet()) {
            if (entry.getValue() < 0) {
                result.add(ActionResult.INVALID_TOKENS_GIVEN);
                return result;
            }
            if (!entry.getKey().isGem() && entry.getValue() > 0) {
                result.add(ActionResult.GOLD_CANNOT_BE_TAKEN);
                return result;
            }
        }
        for (Map.Entry<TokenType, Integer> entry : putBackTokens.entrySet()) {
            if (entry.getValue() < 0 || entry.getKey() == TokenType.Satchel && entry.getValue() > 0) {
                result.add(ActionResult.INVALID_TOKENS_GIVEN);
                return result;
            }
        }

        int playerTotalTokens = 0;
        int totalTaken = 0;
        int totalReturned = 0;

        for (TokenType token : TokenType.values()) {
            int takeTokensNum = takeTokens.getOrDefault(token, 0);
            int putBackTokensNum = putBackTokens.getOrDefault(token, 0);
            int playerCurrentTokensNum = player.getTokens().getOrDefault(token, 0);

            playerTotalTokens += playerCurrentTokensNum;
            totalTaken += takeTokensNum;
            totalReturned += putBackTokensNum;

            // check if any of this token type is being taken or put back
            if (takeTokensNum == 0 && putBackTokensNum == 0) {
                continue;
            }

            if (game.getTokens().getOrDefault(token, 0) < takeTokensNum) {
                result.add(ActionResult.NOT_ENOUGH_TOKENS_ON_BOARD);
                return result;
            }

            // tokens just taken may be returned as well
            if (putBackTokensNum > playerCurrentTokensNum + takeTokensNum) {
                result.add(ActionResult.NOT_ENOUGH_TOKENS_IN_INVENTORY);
                return result;
            }
        }

        // check if player total token inventory goes over 10, and that tokens are only returned to get down to 10
        int tokensAfterTurn = playerTotalTokens + totalTaken - totalReturned;
        if (tokensAfterTurn > 10) {
            result.add(ActionResult.MAXIMUM_TOKENS_IN_INVENTORY);
            return result;
        }
        if (totalReturned > 0 && tokensAfterTurn < 10) {
            result.add(ActionResult.TOO_MANY_TOKENS_RETURNED);
            return result;
        }

        // cannot have doubleTokens > 0 and uniqueTokens > 0 at same time (mutually exclusive options)
        int uniqueTokens = 0; // max value of 3
        int doubleTokens = 0; // max value of 1
        for (Map.Entry<TokenType, Integer> entry : takeTokens.entrySet()) {
            TokenType t = entry.getKey();
            int amount = entry.getValue();
            // invalid if player tries to take >2 of one token type
            if (amount > 2) {
                result.add(ActionResult.INVALID_TOKENS_GIVEN);
                return result;
            } else if (amount == 2) {
                doubleTokens += 1;

                // board pile must have at least 4 of this token for player to take two
                if (game.getTokens().get(t) < 4) {
                    result.add(ActionResult.INVALID_TOKENS_GIVEN);
                    return result;
                }
            } else if (amount == 1) {
                uniqueTokens++;
            }
        }

        // verify either 2 of same token or 3 unique tokens
        // Unless for Trading routes, if player has power 2, can take 1 extra token of different color than doubleToken
        if (player instanceof TradingPostsPlayer tpp && tpp.extraTokenAfterTakingSameColor.isUnlocked()) {
            if (doubleTokens > 1 || uniqueTokens > 3 || (uniqueTokens > 1 && doubleTokens == 1)) {
                result.add(ActionResult.INVALID_TOKENS_GIVEN);
                return result;
            }
        } else if (doubleTokens > 1 || uniqueTokens > 3 || (uniqueTokens > 0 && doubleTokens > 0)) {
            result.add(ActionResult.INVALID_TOKENS_GIVEN);
            return result;
        }

        game.removeTokens(takeTokens);
        game.addTokens(putBackTokens);
        player.takeTokens(takeTokens, putBackTokens);

        if (game.getCurValidActions().contains(Actions.TAKE_TOKEN)) {
            result.add(ActionResult.VALID_ACTION);
        }
        result.add(ActionResult.TURN_COMPLETED);

        // clear list of current player valid actions
        game.clearValidActions();

        return result;

    }

    @Override
    public Action decodeAction(JsonObject jobj) {
        this.takeTokens = ActionJson.tokenAmounts(jobj, "takeTokens", true);
        // optional: an omitted putBackTokens means nothing is returned
        this.putBackTokens = ActionJson.tokenAmounts(jobj, "putBackTokens", false);
        return this;
    }

}
