package ca.hexanome04.splendorgame.control.templates;

import java.util.List;

/**
 * Construct a launch session info.
 *
 * @param gameServer game service name
 * @param players list of players
 * @param creator creator name
 * @param savegame save game name
 * @param botPlayer optional server-managed seat
 */
public record LaunchSessionInfo(String gameServer, List<PlayerInfo> players, String creator, String savegame,
                                String botPlayer) {

    /**
     * Construct launch info for a human-only game.
     *
     * @param gameServer game service name
     * @param players list of players
     * @param creator creator name
     * @param savegame save game name
     */
    public LaunchSessionInfo(String gameServer, List<PlayerInfo> players, String creator, String savegame) {
        this(gameServer, players, creator, savegame, null);
    }
}
