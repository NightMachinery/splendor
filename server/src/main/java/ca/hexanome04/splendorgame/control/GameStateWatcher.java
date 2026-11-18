package ca.hexanome04.splendorgame.control;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.async.DeferredResult;

/**
 * The long-polls on one game's state, held without a thread per poll.
 *
 * <p>A client sends {@code GET /api/sessions/{id}?hash=...} with the MD5 of the state it shows. If
 * the hash is missing or differs from the current state's, the poll is answered at once with the
 * state. Otherwise it is held: Spring keeps the {@link DeferredResult} and no thread waits for it.
 * The next {@link #markDirty()} answers every held poll with the new state, and Spring answers a
 * poll that is still held after the timeout with 204 "No update.".
 *
 * <p>simpoll, which this replaces, started a thread for every held poll, and that thread slept until
 * the timeout even after the client had gone. Anyone could hold thousands of polls on a public
 * session id and exhaust the server's threads.
 *
 * <p>At most {@code maxHeld} polls are held per game. A poll beyond that answers the oldest held poll
 * with 204, as a timeout would, and the client polls again at once. So a flood of polls on one game
 * costs a bounded amount of memory, and a real player's poll is pushed out but never refused.
 *
 * <p>No change can be missed: a held poll is registered only if no {@code markDirty} happened since
 * the state it was compared with was read.
 */
public class GameStateWatcher {

    static final Logger logger = LoggerFactory.getLogger(GameStateWatcher.class);

    /** Body of the answer to a poll that saw no change (the client re-polls on 204). */
    static final String NO_UPDATE = "No update.";

    private static final ResponseEntity<String> NO_UPDATE_RESPONSE =
            ResponseEntity.status(HttpStatus.NO_CONTENT).body(NO_UPDATE);
    private static final ResponseEntity<String> GONE_RESPONSE = ResponseEntity.status(HttpStatus.GONE).body("");

    private final Supplier<String> state;
    private final long timeoutMs;
    private final int maxHeld;

    // guarded by this; in arrival order, so the first one is the oldest
    private final Set<DeferredResult<ResponseEntity<String>>> held = new LinkedHashSet<>();
    // guarded by this; counts the calls to markDirty
    private long changes;
    // guarded by this
    private boolean closed;

    /**
     * Create the watcher for one game.
     *
     * @param state the game state as sent to clients; it must be safe to call from any thread
     * @param timeoutMs how long a poll is held before it is answered with 204
     * @param maxHeld how many polls are held at most (at least 1)
     */
    public GameStateWatcher(Supplier<String> state, long timeoutMs, int maxHeld) {
        this.state = state;
        this.timeoutMs = timeoutMs;
        this.maxHeld = Math.max(1, maxHeld);
    }

    /**
     * MD5 of a state as the client computes it: lower-case hex of the UTF-8 bytes.
     *
     * @param body serialized state
     * @return hash
     */
    public static String hashOf(String body) {
        try {
            MessageDigest md5 = MessageDigest.getInstance("MD5");
            return HexFormat.of().formatHex(md5.digest(body.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("MD5 is not available", e);
        }
    }

    private static ResponseEntity<String> ok(String body) {
        return ResponseEntity.status(HttpStatus.OK).body(body);
    }

    /**
     * Answer a long-poll: at once if the client's hash is outdated, otherwise when the state changes,
     * the timeout passes, or a newer poll pushes this one out.
     *
     * @param hash MD5 of the state the client shows, or null to get the state at once
     * @return the poll's result, possibly already set
     */
    public DeferredResult<ResponseEntity<String>> poll(String hash) {
        final DeferredResult<ResponseEntity<String>> result = new DeferredResult<>(timeoutMs, NO_UPDATE_RESPONSE);
        // after a timeout, an error or a client that went away: Spring completes the result, so forget it
        result.onCompletion(() -> forget(result));

        while (true) {
            long seen;
            synchronized (this) {
                if (closed) {
                    result.setResult(GONE_RESPONSE);
                    return result;
                }
                seen = changes;
            }

            String body = state.get();
            if (hash == null || !hash.equals(hashOf(body))) {
                result.setResult(ok(body));
                return result;
            }

            boolean registered = false;
            DeferredResult<ResponseEntity<String>> pushedOut = null;
            synchronized (this) {
                if (closed) {
                    result.setResult(GONE_RESPONSE);
                    return result;
                }
                if (changes == seen) {
                    if (held.size() >= maxHeld) {
                        Iterator<DeferredResult<ResponseEntity<String>>> oldest = held.iterator();
                        pushedOut = oldest.next();
                        oldest.remove();
                    }
                    held.add(result);
                    registered = true;
                }
            }
            if (pushedOut != null) {
                pushedOut.setResult(NO_UPDATE_RESPONSE);
            }
            if (registered) {
                return result;
            }
            // the state changed after it was read for the comparison: compare again
        }
    }

    private synchronized void forget(DeferredResult<ResponseEntity<String>> result) {
        held.remove(result);
    }

    /**
     * Mark that the game state changed: answer every held poll with the new state.
     * Call it after the change is visible to the state supplier.
     */
    public void markDirty() {
        List<DeferredResult<ResponseEntity<String>>> waiting;
        synchronized (this) {
            changes++;
            if (held.isEmpty()) {
                return;
            }
            waiting = new ArrayList<>(held);
            held.clear();
        }

        ResponseEntity<String> update;
        try {
            update = ok(state.get());
        } catch (RuntimeException e) {
            logger.warn("Could not serialize the game state for the held long-polls: ", e);
            update = ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Server could not retrieve game state.");
        }
        for (DeferredResult<ResponseEntity<String>> poll : waiting) {
            poll.setResult(update);
        }
    }

    /**
     * The game is gone for good: answer every held poll, and every later one, with 410.
     */
    public void close() {
        List<DeferredResult<ResponseEntity<String>>> waiting;
        synchronized (this) {
            closed = true;
            waiting = new ArrayList<>(held);
            held.clear();
        }
        for (DeferredResult<ResponseEntity<String>> poll : waiting) {
            poll.setResult(GONE_RESPONSE);
        }
    }

    /**
     * Number of polls held right now.
     *
     * @return held polls
     */
    public synchronized int heldPolls() {
        return held.size();
    }
}
