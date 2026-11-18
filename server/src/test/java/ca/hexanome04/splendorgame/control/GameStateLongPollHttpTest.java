package ca.hexanome04.splendorgame.control;

import static ca.hexanome04.splendorgame.model.gameversions.GameVersions.BASE_ORIENT;
import static org.assertj.core.api.Assertions.assertThat;

import ca.hexanome04.splendorgame.control.templates.LaunchSessionInfo;
import ca.hexanome04.splendorgame.control.templates.PlayerInfo;
import java.io.IOException;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.server.LocalServerPort;

/**
 * Game state long-polls through the embedded Tomcat, with a 5 s long-poll timeout: held polls take
 * no threads, time out with 204, and are forgotten after the timeout even when the client has gone.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"longpoll.timeout=5000", "longpoll.maxHeldPerGame=1000"})
public class GameStateLongPollHttpTest {

    @LocalServerPort
    int port;

    @Autowired
    SplendorRestController controller;

    private final HttpClient http = HttpClient.newHttpClient();

    private String launch(String sessionId) throws Exception {
        List<PlayerInfo> players = List.of(new PlayerInfo("p1", "c1"), new PlayerInfo("p2", "c2"));
        controller.addSession(sessionId, new LaunchSessionInfo("splendor_" + BASE_ORIENT, players, "p1", ""),
                BASE_ORIENT);
        HttpResponse<String> state = get(sessionId, null);
        assertThat(state.statusCode()).isEqualTo(200);
        return GameStateWatcher.hashOf(state.body());
    }

    private HttpResponse<String> get(String sessionId, String hash) throws Exception {
        String query = hash == null ? "" : "?hash=" + hash;
        HttpRequest request = HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/api/sessions/" + sessionId + query)).GET().build();
        return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static boolean waitFor(BooleanSupplier condition, long maxMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxMs;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) {
                return false;
            }
            Thread.sleep(10);
        }
        return true;
    }

    @Test
    @DisplayName("A held poll without a change is answered with 204 after the timeout, and then forgotten")
    void testHeldPollTimesOutWith204() throws Exception {
        String hash = launch("http-timeout");

        long start = System.currentTimeMillis();
        HttpResponse<String> response = get("http-timeout", hash);
        long elapsed = System.currentTimeMillis() - start;

        assertThat(response.statusCode()).isEqualTo(204);
        assertThat(elapsed).isBetween(4500L, 15_000L);
        assertThat(waitFor(() -> controller.heldPolls("http-timeout") == 0, 2000)).isTrue();
    }

    /** Live threads, not counting Tomcat's request workers (simpoll's were unnamed "Thread-N"). */
    private static long threadsOutsideTomcat() {
        return Thread.getAllStackTraces().keySet().stream()
                .filter(t -> !t.getName().startsWith("http-nio-"))
                .count();
    }

    @Test
    @DisplayName("Many held polls take no threads, and are forgotten after the timeout although the clients left")
    void testHeldPollsTakeNoThreads() throws Exception {
        String hash = launch("http-flood");
        int polls = 60;
        byte[] request = ("GET /api/sessions/http-flood?hash=" + hash + " HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII);

        List<Socket> sockets = new ArrayList<>();
        long before = threadsOutsideTomcat();
        long start = System.currentTimeMillis();
        try {
            for (int i = 0; i < polls; i++) {
                Socket socket = new Socket("127.0.0.1", port);
                sockets.add(socket);
                socket.getOutputStream().write(request);
                socket.getOutputStream().flush();
            }
            assertThat(waitFor(() -> controller.heldPolls("http-flood") == polls, 4000))
                    .as("all %d polls held after %d ms (%d held)", polls, System.currentTimeMillis() - start,
                            controller.heldPolls("http-flood"))
                    .isTrue();
            long during = threadsOutsideTomcat();
            // simpoll started one thread per held poll; a margin for the JVM's own threads
            assertThat(during - before).isLessThan(20);
        } finally {
            for (Socket socket : sockets) {
                try {
                    socket.close();
                } catch (IOException e) {
                    // already closed
                }
            }
        }

        // the clients have gone; the timeout still completes their polls and they are forgotten
        assertThat(waitFor(() -> controller.heldPolls("http-flood") == 0, 10_000)).isTrue();
    }
}
