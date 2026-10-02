package ca.hexanome04.splendorgame.control;

import static org.assertj.core.api.Assertions.assertThat;

import dev.dacbiet.simpoll.Fetcher;
import dev.dacbiet.simpoll.ResultGenerator;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.async.DeferredResult;

/**
 * Long-polls through {@link GameStateWatcher} and simpoll's ResultGenerator, as the game state
 * endpoint uses them. The timeout is long (10 s), so a poll that answers within 2 s was woken by
 * the change and not by its timeout.
 */
public class GameStateWatcherTest {

    private static final long TIMEOUT_MS = 10_000;

    private static void awaitResult(DeferredResult<?> poll, long maxMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxMs;
        while (!poll.hasResult() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10);
        }
    }

    private static String body(DeferredResult<?> poll) {
        ResponseEntity<?> response = (ResponseEntity<?>) poll.getResult();
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) response.getBody();
    }

    @Test
    @DisplayName("A move between the hash comparison and the wait still wakes the poll")
    void testChangeRightAfterHashComparisonWakesPoll() throws Exception {
        GameStateWatcher watcher = new GameStateWatcher();
        AtomicReference<String> state = new AtomicReference<>("A");
        AtomicBoolean moved = new AtomicBoolean();
        // getStringResult reads the state once to compare hashes; the move lands right after that read,
        // before the waiting thread starts. simpoll's own ContentWatcher misses this change.
        Fetcher fetcher = () -> {
            String now = state.get();
            if (moved.compareAndSet(false, true)) {
                state.set("B");
                watcher.markDirty();
            }
            return now;
        };

        DeferredResult<?> poll = ResultGenerator.getStringResult(watcher.forOnePoll(), fetcher,
                DigestUtils.md5Hex("A"), TIMEOUT_MS);
        awaitResult(poll, 2000);

        assertThat(poll.hasResult()).isTrue();
        assertThat(body(poll)).isEqualTo("B");
    }

    @Test
    @DisplayName("A move while the poll waits wakes it with the new state")
    void testChangeDuringWaitWakesPoll() throws Exception {
        GameStateWatcher watcher = new GameStateWatcher();
        AtomicReference<String> state = new AtomicReference<>("A");

        DeferredResult<?> poll = ResultGenerator.getStringResult(watcher.forOnePoll(), state::get,
                DigestUtils.md5Hex("A"), TIMEOUT_MS);
        Thread.sleep(200);
        assertThat(poll.hasResult()).isFalse();

        state.set("B");
        watcher.markDirty();
        awaitResult(poll, 2000);

        assertThat(poll.hasResult()).isTrue();
        assertThat(body(poll)).isEqualTo("B");
    }

    @Test
    @DisplayName("Every waiting poll wakes on one move")
    void testOneChangeWakesEveryPoll() throws Exception {
        GameStateWatcher watcher = new GameStateWatcher();
        AtomicReference<String> state = new AtomicReference<>("A");
        String hash = DigestUtils.md5Hex("A");

        DeferredResult<?> first = ResultGenerator.getStringResult(watcher.forOnePoll(), state::get, hash, TIMEOUT_MS);
        DeferredResult<?> second = ResultGenerator.getStringResult(watcher.forOnePoll(), state::get, hash, TIMEOUT_MS);
        Thread.sleep(200);
        state.set("B");
        watcher.markDirty();
        awaitResult(first, 2000);
        awaitResult(second, 2000);

        assertThat(body(first)).isEqualTo("B");
        assertThat(body(second)).isEqualTo("B");
    }

    @Test
    @DisplayName("Without a move the poll keeps waiting; with an outdated hash it answers at once")
    void testWaitsOnlyForMatchingHash() throws Exception {
        GameStateWatcher watcher = new GameStateWatcher();
        AtomicReference<String> state = new AtomicReference<>("A");

        DeferredResult<?> waiting = ResultGenerator.getStringResult(watcher.forOnePoll(), state::get,
                DigestUtils.md5Hex("A"), TIMEOUT_MS);
        DeferredResult<?> outdated = ResultGenerator.getStringResult(watcher.forOnePoll(), state::get,
                DigestUtils.md5Hex("old"), TIMEOUT_MS);
        Thread.sleep(300);

        assertThat(waiting.hasResult()).isFalse();
        assertThat(outdated.hasResult()).isTrue();
        assertThat(body(outdated)).isEqualTo("A");
    }
}
