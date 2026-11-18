package ca.hexanome04.splendorgame.control;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.async.DeferredResult;

/**
 * Long-polls through {@link GameStateWatcher}, as the game state endpoint uses it. Without a servlet
 * container nothing times out, so a poll that has a result was answered by a change, a newer poll
 * or {@code close}, never by its timeout.
 */
public class GameStateWatcherTest {

    private static final long TIMEOUT_MS = 10_000;

    private static ResponseEntity<?> response(DeferredResult<ResponseEntity<String>> poll) {
        assertThat(poll.hasResult()).isTrue();
        return (ResponseEntity<?>) poll.getResult();
    }

    private static String body(DeferredResult<ResponseEntity<String>> poll) {
        ResponseEntity<?> response = response(poll);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) response.getBody();
    }

    @Test
    @DisplayName("The hash is the client's MD5: lower-case hex of the UTF-8 bytes")
    void testHashMatchesClientMd5() {
        assertThat(GameStateWatcher.hashOf("")).isEqualTo("d41d8cd98f00b204e9800998ecf8427e");
        assertThat(GameStateWatcher.hashOf("é")).isEqualTo("66ddcd97cfdeabb2f6fb8a999b4bc76f");
    }

    @Test
    @DisplayName("A poll without a hash, or with an outdated one, is answered at once")
    void testOutdatedHashAnsweredAtOnce() {
        GameStateWatcher watcher = new GameStateWatcher(() -> "A", TIMEOUT_MS, 8);

        assertThat(body(watcher.poll(null))).isEqualTo("A");
        assertThat(body(watcher.poll(GameStateWatcher.hashOf("old")))).isEqualTo("A");
        assertThat(watcher.heldPolls()).isZero();
    }

    @Test
    @DisplayName("A poll with the current hash is held until a move, and then gets the new state")
    void testChangeWakesHeldPoll() {
        AtomicReference<String> state = new AtomicReference<>("A");
        GameStateWatcher watcher = new GameStateWatcher(state::get, TIMEOUT_MS, 8);

        DeferredResult<ResponseEntity<String>> poll = watcher.poll(GameStateWatcher.hashOf("A"));
        assertThat(poll.hasResult()).isFalse();
        assertThat(watcher.heldPolls()).isEqualTo(1);

        state.set("B");
        watcher.markDirty();

        assertThat(body(poll)).isEqualTo("B");
        assertThat(watcher.heldPolls()).isZero();
    }

    @Test
    @DisplayName("A move between the hash comparison and the hold still answers the poll")
    void testChangeRightAfterHashComparisonIsNotMissed() {
        AtomicReference<String> state = new AtomicReference<>("A");
        AtomicReference<GameStateWatcher> watcher = new AtomicReference<>();
        AtomicBoolean moved = new AtomicBoolean();
        // the move lands right after the state is read for the comparison
        Supplier<String> racingState = () -> {
            String now = state.get();
            if (moved.compareAndSet(false, true)) {
                state.set("B");
                watcher.get().markDirty();
            }
            return now;
        };
        watcher.set(new GameStateWatcher(racingState, TIMEOUT_MS, 8));

        DeferredResult<ResponseEntity<String>> poll = watcher.get().poll(GameStateWatcher.hashOf("A"));

        assertThat(body(poll)).isEqualTo("B");
        assertThat(watcher.get().heldPolls()).isZero();
    }

    @Test
    @DisplayName("One move answers every held poll")
    void testOneChangeWakesEveryPoll() {
        AtomicReference<String> state = new AtomicReference<>("A");
        GameStateWatcher watcher = new GameStateWatcher(state::get, TIMEOUT_MS, 8);
        String hash = GameStateWatcher.hashOf("A");

        DeferredResult<ResponseEntity<String>> first = watcher.poll(hash);
        DeferredResult<ResponseEntity<String>> second = watcher.poll(hash);
        state.set("B");
        watcher.markDirty();

        assertThat(body(first)).isEqualTo("B");
        assertThat(body(second)).isEqualTo("B");
    }

    @Test
    @DisplayName("Held polls start no threads (simpoll started one per poll)")
    void testHeldPollsStartNoThreads() {
        int polls = 500;
        GameStateWatcher watcher = new GameStateWatcher(() -> "A", TIMEOUT_MS, polls);
        String hash = GameStateWatcher.hashOf("A");
        ThreadMXBean threads = ManagementFactory.getThreadMXBean();

        int before = threads.getThreadCount();
        List<DeferredResult<ResponseEntity<String>>> held = new ArrayList<>();
        for (int i = 0; i < polls; i++) {
            held.add(watcher.poll(hash));
        }
        int during = threads.getThreadCount();

        assertThat(watcher.heldPolls()).isEqualTo(polls);
        assertThat(held).noneMatch(DeferredResult::hasResult);
        // a margin for threads the JVM starts on its own (JIT compiler, GC)
        assertThat(during - before).isLessThan(20);
    }

    @Test
    @DisplayName("Beyond the cap, a new poll answers the oldest held poll with 204")
    void testOldestPollPushedOutBeyondCap() {
        AtomicReference<String> state = new AtomicReference<>("A");
        GameStateWatcher watcher = new GameStateWatcher(state::get, TIMEOUT_MS, 3);
        String hash = GameStateWatcher.hashOf("A");

        List<DeferredResult<ResponseEntity<String>>> polls = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            polls.add(watcher.poll(hash));
        }

        ResponseEntity<?> oldest = response(polls.get(0));
        assertThat(oldest.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(oldest.getBody()).isEqualTo(GameStateWatcher.NO_UPDATE);
        assertThat(polls.subList(1, 4)).noneMatch(DeferredResult::hasResult);
        assertThat(watcher.heldPolls()).isEqualTo(3);

        state.set("B");
        watcher.markDirty();
        for (DeferredResult<ResponseEntity<String>> poll : polls.subList(1, 4)) {
            assertThat(body(poll)).isEqualTo("B");
        }
    }

    @Test
    @DisplayName("After close, held and later polls are answered with 410")
    void testCloseAnswersGone() {
        GameStateWatcher watcher = new GameStateWatcher(() -> "A", TIMEOUT_MS, 8);
        DeferredResult<ResponseEntity<String>> held = watcher.poll(GameStateWatcher.hashOf("A"));

        watcher.close();

        assertThat(response(held).getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(response(watcher.poll(null)).getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(watcher.heldPolls()).isZero();
    }

    @Test
    @DisplayName("A state that cannot be serialized answers the held polls with 500 instead of leaving them")
    void testFailingStateAnswers500() {
        AtomicBoolean broken = new AtomicBoolean();
        GameStateWatcher watcher = new GameStateWatcher(() -> {
            if (broken.get()) {
                throw new IllegalStateException("broken");
            }
            return "A";
        }, TIMEOUT_MS, 8);
        DeferredResult<ResponseEntity<String>> held = watcher.poll(GameStateWatcher.hashOf("A"));

        broken.set(true);
        watcher.markDirty();

        assertThat(response(held).getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
