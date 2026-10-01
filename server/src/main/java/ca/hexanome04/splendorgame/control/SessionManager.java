package ca.hexanome04.splendorgame.control;

import ca.hexanome04.splendorgame.control.templates.*;
import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.gameversions.*;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsGame;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Component;

/**
 * Hold all the game sessions available.
 */
@Component
public class SessionManager {

    Map<String, GameSession> gameSessions;

    /**
     * Optional shuffle seed for new games (property gs.shuffleSeed), or null for a random shuffle.
     * Every new game gets the same deal while it is set. Meant for reproducible end-to-end tests,
     * never for real games.
     */
    private Long shuffleSeed;

    /**
     * Initialize the Session Manager.
     */
    @Autowired
    public SessionManager() {
        this.gameSessions = new ConcurrentHashMap<>();
    }

    /**
     * Set the shuffle seed used for new games. A value that is not a whole number fails at startup
     * instead of failing every game launch.
     *
     * @param shuffleSeed seed as a whole number, or null / blank for a random shuffle
     * @throws IllegalArgumentException if the seed is not a whole number
     */
    @Value("${gs.shuffleSeed:}")
    public void setShuffleSeed(String shuffleSeed) {
        if (shuffleSeed == null || shuffleSeed.isBlank()) {
            this.shuffleSeed = null;
            return;
        }
        try {
            this.shuffleSeed = Long.parseLong(shuffleSeed.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("gs.shuffleSeed must be a whole number, got '" + shuffleSeed + "'", e);
        }
    }

    /**
     * Get a game session from the session id.
     *
     * @param sessionId session id for the game
     * @return game session or null (if game session is not found)
     */
    public @Nullable GameSession getGameSession(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        return this.gameSessions.get(sessionId);
    }

    /**
     * Gets the number of sessions created in this session manager.
     *
     * @return The number of sessions
     */
    public int getNumSessions() {
        return gameSessions.size();
    }

    /**
     * Creates and adds a new session to the session manager.
     *
     * @param sessionId session id
     * @param players player in session
     * @param creatorName creator name
     * @param sessionName session name
     * @param version version of the game (which expansions)
     * @return game session instance
     * @throws SplendorException if issue occurred
     */
    public synchronized GameSession createNewSession(String sessionId, List<PlayerInfo> players,
                                        String creatorName, String sessionName,
                                        GameVersions version) throws SplendorException {
        checkSessionId(sessionId);
        checkPlayers(players);
        if (version == null) {
            throw new SplendorException("Game can not be created, unknown game version.");
        }

        GameSession session = new GameSession(sessionId, creatorName, sessionName);
        session.setGame(this.launchNewGame(version, players));

        gameSessions.put(sessionId, session);
        return session;
    }

    /**
     * Creates a new game session for a pre-existing game instance (for game saves).
     *
     * @param sessionId session id
     * @param game existing game instance
     * @param launchSessionInfo info to launch the session
     * @return new game session
     * @throws SplendorException if issue occurred
     */
    public synchronized GameSession createSession(String sessionId, Game game,
                                     LaunchSessionInfo launchSessionInfo) throws SplendorException {
        checkSessionId(sessionId);
        checkPlayers(launchSessionInfo.players());

        List<Player> curPlayers = game.getPlayers();

        // have to reassign players in the order they appear
        if (launchSessionInfo.players().size() != curPlayers.size()) {
            throw new SplendorException("Game can not be created, launch players count "
                    + "does not match pre-existing count");
        }
        Map<String, Player> playerMap = curPlayers.stream()
                .collect(Collectors.toMap(Player::getName, item -> item));
        Map<String, PlayerInfo> playerInfoMap = launchSessionInfo.players().stream()
                .collect(Collectors.toMap(PlayerInfo::name, item -> item));

        for (PlayerInfo pi : launchSessionInfo.players()) {
            String name = pi.name();
            Player p = playerMap.get(name); // idk color might have changed
            if (p != null) {
                p.setColour(pi.colour());

                // remove the ones that were already in the game covered
                playerMap.remove(name);
                playerInfoMap.remove(name);
            }
        }

        // now we assign new players to inactive players
        List<Player> inactivePlayers = new ArrayList<>(
                curPlayers.stream().filter(p -> playerMap.containsKey(p.getName())).toList()
        );
        if (inactivePlayers.size() != playerInfoMap.keySet().size()) {
            throw new SplendorException("Game can not be created, inactive player list "
                    + "size does not match remaining player info list");
        }

        // pop an inactive player out of list and assign it to a player who's not been set
        for (PlayerInfo pi : playerInfoMap.values()) {
            Player p = inactivePlayers.remove(0);
            p.setName(pi.name());
            p.setColour(pi.colour());
        }

        GameSession session = new GameSession(sessionId, launchSessionInfo.creator(), launchSessionInfo.savegame());
        session.setGame(game);

        gameSessions.put(sessionId, session);
        return session;
    }

    /**
     * Create a new game with the specified information and launch it.
     *
     * @param version game version
     * @param players list of player infos
     * @return newly created game
     */
    public Game launchNewGame(GameVersions version, List<PlayerInfo> players) {

        Game game = switch (version) {
            case BASE_ORIENT -> new OrientGame(15, 0);
            case BASE_ORIENT_CITIES, BASE_ORIENT_CITIES_NOBLES -> new CitiesGame(version, 0);
            case BASE_ORIENT_TRADE_ROUTES -> new TradingPostsGame(15, 0);
        };
        if (shuffleSeed != null) {
            game.setShuffleRandom(new Random(shuffleSeed));
        }

        List<Player> playerList = new ArrayList<>();
        for (PlayerInfo p : players) {
            Player newPlayer = game.createPlayer(p.name(), p.colour());
            playerList.add(newPlayer);
        }
        game.setPlayers(playerList);
        game.createSplendorBoard();
        game.initBoard();

        return game;
    }

    private void checkSessionId(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new SplendorException("Game can not be created, missing session id.");
        }
        // Refuse creation if session with this ID already exists
        if (gameSessions.containsKey(sessionId)) {
            throw new SplendorException("Game can not be created, the requested ID " + sessionId
                    + " is already in use.");
        }
    }

    private static void checkPlayers(List<PlayerInfo> players) {
        // Refuse creation if incorrect number of players in session
        if (players == null || players.size() < 2 || players.size() > 4) {
            throw new SplendorException("Game can not be created, 2-4 players required");
        }
        Set<String> names = new HashSet<>();
        for (PlayerInfo p : players) {
            if (p == null || p.name() == null || p.name().isBlank()) {
                throw new SplendorException("Game can not be created, every player needs a name.");
            }
            if (!names.add(p.name())) {
                throw new SplendorException("Game can not be created, player '" + p.name() + "' appears twice.");
            }
        }
    }

}
