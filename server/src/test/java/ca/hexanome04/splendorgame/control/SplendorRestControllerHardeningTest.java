package ca.hexanome04.splendorgame.control;

import static ca.hexanome04.splendorgame.model.gameversions.GameVersions.BASE_ORIENT;
import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import ca.hexanome04.splendorgame.control.templates.LaunchSessionInfo;
import ca.hexanome04.splendorgame.control.templates.PlayerInfo;
import ca.hexanome04.splendorgame.model.Player;
import ca.hexanome04.splendorgame.model.TokenType;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.async.DeferredResult;

/**
 * REST layer behaviour for malformed input, game over and concurrent submissions.
 * Uses mocks for the lobby service, so nothing goes over the network.
 */
public class SplendorRestControllerHardeningTest {

    private static final String SERVICE = "splendor";
    private static final String SESSION = "session-1";
    private static final String TAKE_THREE = "{\"takeTokens\":{\"Red\":1,\"Blue\":1,\"Green\":1},\"putBackTokens\":{}}";
    private static final String PASS = "{\"takeTokens\":{},\"putBackTokens\":{}}";

    Authentication auth;
    Initializer initializer;
    SessionManager sessionManager;
    SplendorRestController controller;

    @BeforeEach
    void setup() throws Exception {
        auth = Mockito.mock(Authentication.class);
        Mockito.when(auth.getNameFromToken("token-p1")).thenReturn("p1");
        Mockito.when(auth.getNameFromToken("token-p2")).thenReturn("p2");
        initializer = Mockito.mock(Initializer.class);

        sessionManager = new SessionManager();
        controller = new SplendorRestController(sessionManager, auth, Mockito.mock(GameSavesManager.class),
                SERVICE, 10000);
        controller.setInitializer(initializer);

        List<PlayerInfo> players = List.of(new PlayerInfo("p1", "c1"), new PlayerInfo("p2", "c2"));
        controller.addSession(SESSION, new LaunchSessionInfo(SERVICE + "_" + BASE_ORIENT, players, "p1", ""),
                BASE_ORIENT);
    }

    private Game game() {
        return sessionManager.getGameSession(SESSION).getGame();
    }

    private ResponseEntity<String> put(String token, String player, Actions action, String body) {
        return controller.putAction(token, SESSION, player, action, body);
    }

    /** Both players pass once with Player p1 at 15 points: the game ends after p2's turn. */
    private void playToGameOver() {
        game().getPlayerFromName("p1").addPrestigePoints(15);
        assertThat(put("token-p1", "p1", Actions.TAKE_TOKEN, PASS).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(put("token-p2", "p2", Actions.TAKE_TOKEN, PASS).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(game().isGameOver()).isTrue();
    }

    @Test
    @DisplayName("Malformed or invalid action bodies are answered with 400 and a message")
    void testMalformedBodiesGive400() {
        String[][] requests = {
            {"TAKE_TOKEN", "this is not json"},
            {"TAKE_TOKEN", "[1, 2, 3]"},
            {"TAKE_TOKEN", "\"text\""},
            {"TAKE_TOKEN", ""},
            {"TAKE_TOKEN", null},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Gold\":1},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":-1},\"putBackTokens\":{}}"},
            {"TAKE_TOKEN", "{\"takeTokens\":{\"Red\":0.5},\"putBackTokens\":{}}"},
            {"BUY_CARD", "{\"cardId\":\"98\",\"tokens\":{}}"},
            {"BUY_CARD", "{\"cardId\":\"no-such-card\",\"tokens\":{}}"},
            {"BUY_CARD", "{\"cardId\":[\"01\"],\"tokens\":{}}"},
            {"BUY_CARD", "{\"cardId\":\"01\",\"tokens\":{\"Red\":-4}}"},
            {"RESERVE_CARD", "{\"cardId\":\"99\"}"},
            {"CASCADE_1", "{\"cardId\":\"01\"}"},
            {"CHOOSE_CITY", "{\"cityId\":\"40001\"}"},
        };
        for (String[] request : requests) {
            ResponseEntity<String> response = put("token-p1", "p1", Actions.valueOf(request[0]), request[1]);
            assertThat(response.getStatusCode()).as(request[0] + " " + request[1]).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(response.getBody()).as(request[0] + " " + request[1]).isNotBlank();
        }
        // nothing happened
        assertThat(game().getTurnCounter()).isEqualTo(0);
        assertThat(game().getTokens().get(TokenType.Gold)).isEqualTo(5);
        assertThat(game().getPlayerFromName("p1").getTokens().get(TokenType.Gold)).isEqualTo(0);
    }

    @Test
    @DisplayName("A token that does not resolve to the player is refused with 401, not a crash")
    void testUnknownTokenGives401() {
        assertThat(put("unknown", "p1", Actions.TAKE_TOKEN, TAKE_THREE).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(put(null, "p1", Actions.TAKE_TOKEN, TAKE_THREE).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(put("token-p2", "p1", Actions.TAKE_TOKEN, TAKE_THREE).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(game().getTurnCounter()).isEqualTo(0);
    }

    @Test
    @DisplayName("Acting out of turn gives 400 with an explanation")
    void testOutOfTurnGives400() {
        ResponseEntity<String> response = put("token-p2", "p2", Actions.TAKE_TOKEN, TAKE_THREE);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isNotBlank();
    }

    @Test
    @DisplayName("The winning action succeeds even when the lobby service cannot delete the session")
    void testGameOverSurvivesLobbyFailure() {
        Mockito.when(initializer.deleteGameSession(SESSION)).thenThrow(new RuntimeException("lobby service down"));

        playToGameOver();

        Mockito.verify(initializer, Mockito.times(1)).deleteGameSession(SESSION);
        assertThat(game().getWinner()).extracting(Player::getName).containsExactly("p1");
    }

    private List<ILoggingEvent> warningsDuring(Runnable run) {
        Logger log = (Logger) LoggerFactory.getLogger(SplendorRestController.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        log.addAppender(appender);
        try {
            run.run();
        } finally {
            log.detachAppender(appender);
        }
        return appender.list.stream().filter(e -> e.getLevel() == Level.WARN).toList();
    }

    @Test
    @DisplayName("A lobby service that refuses to delete the finished session is logged with its answer")
    void testLobbyRefusalIsLogged() {
        // the LS's REST client does not throw on an error status, it hands back the response
        Mockito.when(initializer.deleteGameSession(SESSION)).thenReturn(
                ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("{\"error\":\"invalid_token\"}"));

        List<ILoggingEvent> warnings = warningsDuring(this::playToGameOver);

        assertThat(warnings).anySatisfy(e -> assertThat(e.getFormattedMessage())
                .contains(SESSION, "refused", "401", "invalid_token"));
        assertThat(game().getWinner()).extracting(Player::getName).containsExactly("p1");
    }

    @Test
    @DisplayName("A lobby service that deletes the finished session causes no warning")
    void testLobbyDeleteOkIsNotLogged() {
        Mockito.when(initializer.deleteGameSession(SESSION)).thenReturn(ResponseEntity.ok().build());

        List<ILoggingEvent> warnings = warningsDuring(this::playToGameOver);

        assertThat(warnings).noneSatisfy(e -> assertThat(e.getFormattedMessage()).contains("lobby service"));
    }

    @Test
    @DisplayName("After game over the actions endpoint answers an empty list and new actions are refused")
    void testActionsAfterGameOver() {
        playToGameOver();

        ResponseEntity actions = controller.getActions(SESSION, "p1");
        assertThat(actions.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(actions.getBody()).isEqualTo("[]");
        assertThat(controller.getActions(SESSION, "p2").getBody()).isEqualTo("[]");

        ResponseEntity<String> late = put("token-p1", "p1", Actions.TAKE_TOKEN, PASS);
        assertThat(late.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(late.getBody()).contains("over");
    }

    @Test
    @DisplayName("Long-poll watchers wake up when the game ends, even if the lobby service call fails")
    void testWatchersWokenOnGameOver() throws Exception {
        Mockito.when(initializer.deleteGameSession(SESSION)).thenThrow(new RuntimeException("lobby service down"));
        game().getPlayerFromName("p1").addPrestigePoints(15);
        assertThat(put("token-p1", "p1", Actions.TAKE_TOKEN, PASS).getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<?> now = (ResponseEntity<?>) controller.getGameState(SESSION, null).getResult();
        String hash = GameStateWatcher.hashOf((String) now.getBody());
        DeferredResult<?> waiting = controller.getGameState(SESSION, hash);
        assertThat(waiting.hasResult()).isFalse();

        assertThat(put("token-p2", "p2", Actions.TAKE_TOKEN, PASS).getStatusCode()).isEqualTo(HttpStatus.OK);

        long deadline = System.currentTimeMillis() + 5000;
        while (!waiting.hasResult() && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertThat(waiting.hasResult()).isTrue();
        ResponseEntity<?> update = (ResponseEntity<?>) waiting.getResult();
        assertThat(update.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonObject state = JsonParser.parseString((String) update.getBody()).getAsJsonObject();
        assertThat(state.get("gameOver").getAsBoolean()).isTrue();
    }

    @Test
    @DisplayName("Simultaneous submissions of the same move are applied once")
    void testConcurrentSubmissionsAppliedOnce() throws Exception {
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<ResponseEntity<String>>> futures = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                Callable<ResponseEntity<String>> submit = () -> {
                    start.await();
                    return put("token-p1", "p1", Actions.TAKE_TOKEN, TAKE_THREE);
                };
                futures.add(pool.submit(submit));
            }
            start.countDown();
            int ok = 0;
            for (Future<ResponseEntity<String>> f : futures) {
                if (f.get(30, TimeUnit.SECONDS).getStatusCode() == HttpStatus.OK) {
                    ok++;
                }
            }
            assertThat(ok).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
        Player p1 = game().getPlayerFromName("p1");
        assertThat(p1.getTokens().get(TokenType.Red)).isEqualTo(1);
        assertThat(game().getTokens().get(TokenType.Red)).isEqualTo(3);
        assertThat(game().getTurnCounter()).isEqualTo(1);
    }

    @Test
    @DisplayName("A launch request with a null savegame starts a new game")
    void testLaunchWithNullSavegame() {
        List<PlayerInfo> players = List.of(new PlayerInfo("a", "c1"), new PlayerInfo("b", "c2"));
        ResponseEntity response = controller.launchSession("s2",
                new LaunchSessionInfo(SERVICE + "_" + BASE_ORIENT, players, "a", null));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sessionManager.getGameSession("s2")).isNotNull();
    }

    @Test
    @DisplayName("A launch request with missing or duplicate players is refused with 400")
    void testLaunchWithBadPlayers() {
        String service = SERVICE + "_" + BASE_ORIENT;
        assertThat(controller.launchSession("s3", new LaunchSessionInfo(service, null, "a", "")).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        List<PlayerInfo> duplicate = List.of(new PlayerInfo("a", "c1"), new PlayerInfo("a", "c2"));
        assertThat(controller.launchSession("s3", new LaunchSessionInfo(service, duplicate, "a", "")).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        List<PlayerInfo> one = List.of(new PlayerInfo("a", "c1"));
        assertThat(controller.launchSession("s3", new LaunchSessionInfo(service, one, "a", "")).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(sessionManager.getGameSession("s3")).isNull();
    }
}
