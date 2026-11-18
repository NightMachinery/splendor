package ca.hexanome04.splendorgame.control;

import ca.hexanome04.splendorgame.control.templates.LaunchSessionInfo;
import ca.hexanome04.splendorgame.control.templates.PlayerInfo;
import ca.hexanome04.splendorgame.model.GameSession;
import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.SplendorException;
import ca.hexanome04.splendorgame.model.action.ActionDecoder;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.async.DeferredResult;


/**
 * Rest controller for all API endpoints of Splendor game.
 */
@CrossOrigin(origins = "*", maxAge = 3600)
@RestController
public class SplendorRestController {

    final Logger logger = LoggerFactory.getLogger(SplendorRestController.class);

    private String gameServiceName;
    private final SessionManager sessionManager;
    private final Authentication auth;
    private final GameSavesManager gameSavesManager;
    private final long longPollTimeout;
    private final Map<String, GameStateWatcher> gameWatcher;

    // how many state long-polls are held at once per game; a poll beyond that pushes out the oldest
    @Value("${longpoll.maxHeldPerGame:64}")
    private int maxHeldPollsPerGame = 64;

    @Autowired
    Initializer initializer;

    /**
     * Create an instance of Splendor's REST controller.
     *
     * @param sessionManager session manager
     * @param auth methods relating to authentication with LS
     * @param gameSavesManager game saves manager
     * @param gameServiceName game service name
     * @param longPollTimeout timeout for long polling
     */

    public SplendorRestController(@Autowired SessionManager sessionManager,
                                  @Autowired Authentication auth,
                                  @Autowired GameSavesManager gameSavesManager,
                                  @Value("${gs.name}") String gameServiceName,
                                  @Value("${longpoll.timeout}") int longPollTimeout) {
        this.sessionManager = sessionManager;
        this.auth = auth;
        this.gameSavesManager = gameSavesManager;
        this.gameServiceName = gameServiceName;
        this.longPollTimeout = longPollTimeout;
        this.gameWatcher = new ConcurrentHashMap<>();
    }

    /**
     * Replace the initializer (used by tests that cannot reach a lobby service).
     *
     * @param initializer initializer to use for lobby service calls
     */
    void setInitializer(Initializer initializer) {
        this.initializer = initializer;
    }

    private GameStateWatcher newWatcher(GameSession session) {
        // serialized under the session lock, so that an action cannot change the game halfway
        return new GameStateWatcher(() -> {
            synchronized (session) {
                return SplendorTypeAdapter.newClientGson().toJson(session.getGame());
            }
        }, longPollTimeout, maxHeldPollsPerGame);
    }

    private GameStateWatcher watcherFor(String sessionId, GameSession session) {
        return gameWatcher.computeIfAbsent(sessionId, id -> newWatcher(session));
    }

    /**
     * Number of state long-polls held right now on a session (for tests).
     *
     * @param sessionId session id
     * @return held polls, 0 for an unknown session
     */
    int heldPolls(String sessionId) {
        GameStateWatcher watcher = gameWatcher.get(sessionId);
        return watcher == null ? 0 : watcher.heldPolls();
    }

    private static JsonObject parseActionBody(String bodyData) {
        if (bodyData == null || bodyData.isBlank()) {
            return new JsonObject();
        }
        JsonElement element;
        try {
            element = JsonParser.parseString(bodyData);
        } catch (JsonParseException e) {
            throw new SplendorException("The request body is not valid JSON.");
        }
        if (element.isJsonNull()) {
            return new JsonObject();
        }
        if (!element.isJsonObject()) {
            throw new SplendorException("The request body must be a JSON object.");
        }
        return element.getAsJsonObject();
    }

    /**
     * Check if server is online.
     *
     * @return Quick statement confirming whether server is online
     */
    @GetMapping(value = "/api/online", produces = "application/json; charset=utf-8")
    public String online() {
        return "The server currently has " + sessionManager.getNumSessions() + " sessions created.";

    }

    /**
     * Launch a session (only from lobby service).
     *
     * @param sessionId session id for new session
     * @param launchSessionInfo information about the new session
     * @return HTTP response entity
     */
    @PutMapping(value = "/api/sessions/{sessionId}", consumes = "application/json; charset=utf-8")
    public ResponseEntity launchSession(@PathVariable String sessionId, @RequestBody LaunchSessionInfo launchSessionInfo) {

        try {
            if (launchSessionInfo == null) {
                throw new SplendorException("Missing launch session info.");
            }
            if (launchSessionInfo.gameServer() == null) {
                throw new SplendorException("Missing service name in launch session info.");
            }

            // verify if game service name is valid.
            boolean validGameServiceName = false;
            GameVersions gameVersion = null;
            for (GameVersions gv : GameVersions.values()) {
                if (launchSessionInfo.gameServer().equals(gameServiceName + "_" + gv)) {
                    validGameServiceName = true;
                    gameVersion = gv;
                    break;
                }
            }
            if (!validGameServiceName) {
                throw new SplendorException("Lobby Service did not specify a matching Service name.");
            }

            if (sessionManager.getGameSession(sessionId) != null) {
                throw new SplendorException("Game can not be launched. Id is already in use.");
            }

            // Looks good, lets create the game
            this.addSession(sessionId, launchSessionInfo, gameVersion);

            return ResponseEntity.status(HttpStatus.OK).build();
        } catch (SplendorException e) {
            logger.warn("Splendor issue while launching session: ", e);
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
        } catch (Exception e) {
            logger.warn("Unable to launch game session: ", e);
            // Something went wrong. Send a http-400 and pass the exception message as body payload.
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Server ran into an issue.");
        }
    }

    /**
     * Adds a session to the session manger and initializes the game.
     *
     * @param sessionId session id of game
     * @param launchSessionInfo launch session info of game
     * @param gameVersion  game version to launch as
     * @throws Exception thrown due to IO or invalid information given
     */
    protected void addSession(String sessionId, LaunchSessionInfo launchSessionInfo, GameVersions gameVersion) throws Exception {
        if (launchSessionInfo.players() == null) {
            throw new SplendorException("Missing players in launch session info.");
        }
        String savegame = launchSessionInfo.savegame() == null ? "" : launchSessionInfo.savegame();
        if (!savegame.isEmpty()) {
            // retrieve game state from save data
            Game game = gameSavesManager.getGameSaveData(savegame);
            if (game == null) {
                logger.warn("Error while launching session: Retrieved game save state is null!");
                throw new SplendorException("Unable to load previous game save state!");
            }
            sessionManager.createSession(sessionId, game, launchSessionInfo);
        } else {
            sessionManager.createNewSession(sessionId, launchSessionInfo.players(),
                    launchSessionInfo.creator(),
                    savegame,
                    gameVersion);
        }
        logger.info("Launched new game session: " + sessionId);
        gameWatcher.put(sessionId, newWatcher(sessionManager.getGameSession(sessionId)));
    }

    /**
     * Obtain the game state of specified session (a long-poll, see {@link GameStateWatcher}).
     *
     * @param sessionId session id to get game state of
     * @param hash optional MD5 of the state the client shows; when it matches, the request is held
     *             until the state changes (200) or the long-poll timeout passes (204)
     * @return JSON object of game state
     */
    @GetMapping(value = "/api/sessions/{sessionId}", produces = "application/json; charset=utf-8")
    public DeferredResult<ResponseEntity<String>> getGameState(@PathVariable String sessionId,
                                                               @RequestParam(required = false) String hash) {
        try {
            // Check if session exists
            GameSession game = sessionManager.getGameSession(sessionId);
            if (game == null) {
                throw new SplendorException("There is no session associated this session ID: " + sessionId + ".");
            }
            return watcherFor(sessionId, game).poll(hash);
        } catch (SplendorException e) {
            DeferredResult<ResponseEntity<String>> result = new DeferredResult<>();
            result.setResult(ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage()));
            return result;
        } catch (Exception e) {
            logger.warn("Issue while getting game state: ", e);
            DeferredResult<ResponseEntity<String>> result = new DeferredResult<>();
            result.setResult(ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("Server could not retrieve game state."));
            return result;
        }
    }

    /**
     * Get players in the specified game session.
     *
     * @param sessionId game session id
     * @return JSON object of players
     */
    @GetMapping(value = "/api/sessions/{sessionId}/players", produces = "application/json; charset=utf-8")
    public ResponseEntity getPlayers(@PathVariable String sessionId) {
        try {
            if (sessionManager.getGameSession(sessionId) == null) {
                throw new SplendorException("There is no session associated this session ID: " + sessionId + ".");
            }

            GameSession session = sessionManager.getGameSession(sessionId);
            String serializedPlayers;
            synchronized (session) {
                serializedPlayers = SplendorTypeAdapter.newClientGson().toJson(session.getGame().getPlayers());
            }
            return ResponseEntity.status(HttpStatus.OK).body(serializedPlayers);
        } catch (SplendorException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
        } catch (Exception e) {
            logger.warn("Issue while retrieving player data: ", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("Server ran into an issue while retrieving player data.");
        }
    }

    /**
     * Obtain the available actions for this turn.
     *
     * @param sessionId session id to get actions for
     * @param playerName player whose action is being put
     * @return JSON object of available actions
     */
    @GetMapping(value = "/api/sessions/{sessionId}/players/{playerName}/actions",
            produces = "application/json; charset=utf-8")
    public ResponseEntity getActions(@PathVariable String sessionId, @PathVariable String playerName) {
        try {
            // Check if session exists
            GameSession session = sessionManager.getGameSession(sessionId);
            if (session == null) {
                throw new SplendorException("There is no session associated this session ID: " + sessionId + ".");
            }
            String serializedActions;
            synchronized (session) {
                // Check if player exists
                Game game = session.getGame();
                Player player = game.getPlayerFromName(playerName);
                if (player == null) {
                    throw new SplendorException("The specified player does not exist in this session.");
                }

                // nobody has anything left to do once the game is over
                if (game.isGameOver()) {
                    return ResponseEntity.status(HttpStatus.OK).body("[]");
                }

                Player current = game.getTurnCurrentPlayer();
                if (current == null || !player.getName().equals(current.getName())) {
                    throw new SplendorException("This player has no valid actions because it is not their turn.");
                }

                // If so, serialize actions and place it as body in a ResponseEntity
                List<String> actions = new ArrayList<>();
                for (Actions action : game.getCurValidActions()) {
                    actions.add(action.toString());
                }
                serializedActions = SplendorTypeAdapter.newClientGson().toJson(actions);
            }
            return ResponseEntity.status(HttpStatus.OK).body(serializedActions);
        } catch (SplendorException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
        } catch (Exception e) {
            logger.warn("Issue while retrieving all possible actions: ", e);
            // Something went wrong. Send a http-400 and pass the exception message as body payload.
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(e.getMessage());
        }
    }

    /**
     * Perform an action to specified session for specified player.
     * Will perform checks to ensure correct player is performing the action
     * and that the player is able to perform the action.
     *
     * @param token access_token
     * @param sessionId session id
     * @param playerName player name who is performing action
     * @param actionIdentifier action identifier
     * @param bodyData JSON string information of action
     * @return String (empty is OK)
     */
    @PutMapping(value = "/api/sessions/{sessionId}/players/{playerName}/actions/{actionIdentifier}",
            consumes = "application/json; charset=utf-8")
    public ResponseEntity<String> putAction(@RequestParam("access_token") String token, @PathVariable String sessionId,
                                            @PathVariable String playerName, @PathVariable Actions actionIdentifier,
                                            @RequestBody String bodyData) {

        try {
            GameSession session = sessionManager.getGameSession(sessionId);
            if (session == null) {
                throw new SplendorException("There is no session associated this session ID: " + sessionId + ".");
            }
            if (session.getGame().getPlayerFromName(playerName) == null) {
                throw new SplendorException("The specified player does not exist in this session.");
            }

            // checked outside the session lock: it is a network call to the lobby service
            if (token == null || token.isEmpty() || !playerName.equals(auth.getNameFromToken(token))) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("Token does not match requested players name.");
            }

            JsonObject jobj = parseActionBody(bodyData);

            boolean gameEnded;
            synchronized (session) {
                Game game = session.getGame();
                if (game.isGameOver()) {
                    throw new SplendorException(ActionResult.GAME_OVER.getDescription());
                }
                if (!game.getCurValidActions().contains(actionIdentifier)) {
                    throw new SplendorException("Given action is not valid: " + actionIdentifier);
                }

                logger.info("Valid actions BEFORE turn: " + game.getCurValidActions());

                ArrayList<ActionResult> actionResult =
                        game.takeAction(playerName, ActionDecoder.createAction(actionIdentifier.toString(), jobj));

                if (!actionResult.contains(ActionResult.VALID_ACTION)) {
                    // Only errors end up here: results that require a follow-up action come with VALID_ACTION.
                    Optional<ActionResult> result = actionResult.stream()
                            .filter(ar -> ar != ActionResult.TURN_COMPLETED)
                            .findFirst();
                    if (result.isPresent() && !result.get().getDescription().isEmpty()) {
                        throw new SplendorException(result.get().getDescription());
                    } else {
                        throw new SplendorException("Invalid action performed.");
                    }
                }

                logger.info("Valid actions AFTER turn:  " + game.getCurValidActions() + "\n");
                gameEnded = game.isGameOver();
            }

            // mark that the game state has changed, before the (slow, fallible) lobby service call
            watcherFor(sessionId, session).markDirty();

            if (gameEnded) {
                deleteLobbySession(sessionId);
            }
            return ResponseEntity.status(HttpStatus.OK).body("");
        } catch (SplendorException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
        } catch (Exception e) {
            logger.warn("Issue while executing action: ", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body("Server ran into an issue while executing an action.");
        }
    }

    /**
     * Delete a finished game's session from the lobby service. A failure is only logged: the game is
     * over either way. The REST client does not throw on an error status (see
     * {@link EmptyRestTemplateErrorHandler}), so a refusal comes back as a response and is checked here.
     *
     * @param sessionId session id
     */
    private void deleteLobbySession(String sessionId) {
        try {
            ResponseEntity<?> response = initializer.deleteGameSession(sessionId);
            if (response == null || !response.getStatusCode().is2xxSuccessful()) {
                logger.warn("Game {} ended, but the lobby service refused to delete its session: {} {}", sessionId,
                        response == null ? "no response" : response.getStatusCodeValue(),
                        response == null ? "" : String.valueOf(response.getBody()));
            }
        } catch (Exception e) {
            logger.warn("Game " + sessionId + " ended, but the lobby service session could not be deleted: ", e);
        }
    }

    /**
     * Restart an already launched game.
     *
     * @param token token of player
     * @param sessionId session id
     * @param bodyData body data in post
     * @return String (empty is OK)
     */
    @PostMapping(value = "/api/sessions/{sessionId}/restart",
            consumes = "text/plain; charset=utf-8")
    public ResponseEntity<String> restartGame(@RequestParam("access_token") String token,
                                              @PathVariable String sessionId,
                                              @RequestBody(required = false) String bodyData) {
        try {
            if (sessionManager.getGameSession(sessionId) == null) {
                throw new SplendorException("There is no session associated this session ID: " + sessionId + ".");
            }
            GameSession gameSession = sessionManager.getGameSession(sessionId);
            String creatorName = gameSession.getCreatorUsername();

            if (token == null || token.isEmpty() || creatorName == null
                    || !creatorName.equals(auth.getNameFromToken(token))) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body("Only the creator of the game can restart the game.");
            }

            // username matches, maybe we add a vote to restart in the future?
            // recreate all info to launch a game
            synchronized (gameSession) {
                GameVersions gameVersion = gameSession.getGame().getGameVersion();

                List<PlayerInfo> playersInfo = new ArrayList<>();
                for (Player p : gameSession.getGame().getPlayers()) {
                    playersInfo.add(new PlayerInfo(p.getName(), p.getColour()));
                }

                Game newGame = sessionManager.launchNewGame(gameVersion, playersInfo);
                gameSession.setGame(newGame);
            }

            logger.info("Restarted game session: " + sessionId);

            // game has updated
            watcherFor(sessionId, gameSession).markDirty();

            return ResponseEntity.status(HttpStatus.OK).body("");
        } catch (SplendorException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
        } catch (Exception e) {
            logger.warn("Issue while restarting game: ", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Issue while trying to restart game.");
        }
    }

}
