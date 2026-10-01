package ca.hexanome04.splendorgame.model.gameversions.tradingposts;

import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import ca.hexanome04.splendorgame.model.gameversions.orient.*;
import java.util.List;

/**
 * Class that represents the current state of an orient + trading posts game.
 */
public class TradingPostsGame extends OrientGame {

    /**
     * Creates a Splendor Game with the board state, number of prestige points to win and ordered player list.
     *
     * @param prestigePointsToWin The amount of prestige points needed to win the game.
     * @param turnCounter         The turn id associated with the player.
     */
    public TradingPostsGame(int prestigePointsToWin, int turnCounter) {
        super(GameVersions.BASE_ORIENT_TRADE_ROUTES, prestigePointsToWin, turnCounter);
    }

    /**
     * Unlock the powers the player now qualifies for. Runs at the end of the turn, after the noble visit
     * (power 4 needs a noble) and before the win check, so points gained from powers count this turn.
     *
     * @param player current player
     * @param results results of the action (unchanged: powers never need a choice)
     */
    @Override
    protected void expansionEndOfTurnChecks(Player player, List<ActionResult> results) {
        TradingPostsPlayer p = (TradingPostsPlayer) player;

        // Power 1
        if (!p.extraTokenAfterPurchase.isUnlocked() && p.extraTokenAfterPurchase.conditionMet(p)) {
            p.extraTokenAfterPurchase.unlockPower(p);
        }

        // Power 2
        if (!p.extraTokenAfterTakingSameColor.isUnlocked() && p.extraTokenAfterTakingSameColor.conditionMet(p)) {
            p.extraTokenAfterTakingSameColor.unlockPower(p);
        }

        // Power 3
        if (!p.goldTokenWorthTwoTokens.isUnlocked() && p.goldTokenWorthTwoTokens.conditionMet(p)) {
            p.goldTokenWorthTwoTokens.unlockPower(p);
        }

        // Power 4
        if (!p.addFivePrestigePoints.isUnlocked() && p.addFivePrestigePoints.conditionMet(p)) {
            p.addFivePrestigePoints.unlockPower(p);
            p.addFivePrestigePoints.execute(p);
        }

        // Power 5
        if (!p.addPrestigePointsWithCoatsOfArms.isUnlocked() && p.addPrestigePointsWithCoatsOfArms.conditionMet(p)) {
            p.addPrestigePointsWithCoatsOfArms.unlockPower(p);
        }
    }

    /**
     * Creates a trading post player.
     *
     * @param name name of the player
     * @param colour color of the player
     * @return player created
     */
    @Override
    public Player createPlayer(String name, String colour) {
        return new TradingPostsPlayer(name, colour);
    }

}
