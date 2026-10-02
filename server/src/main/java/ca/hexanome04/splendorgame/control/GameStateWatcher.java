package ca.hexanome04.splendorgame.control;

import dev.dacbiet.simpoll.ContentWatcher;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Change notifications for the long-polls on one game, without simpoll's missed wake-up.
 *
 * <p>simpoll's {@link ContentWatcher} lets {@code ResultGenerator.getStringResult} compare the
 * client's hash with the state on the request thread, and then starts a thread that waits on
 * whatever latch is current when that thread gets to run. {@code markDirty} replaces the latch, so
 * a move that lands between the comparison and the start of the wait is never seen: the poll sleeps
 * until its timeout (30 s) although the state has changed.
 *
 * <p>Here every long-poll gets its own watcher from {@link #forOnePoll()}, which takes the current
 * latch before the hash is compared. A change after that moment releases exactly that latch, and a
 * change before it is already in the state the comparison reads, so no change can be missed.
 */
public class GameStateWatcher extends ContentWatcher {

    private volatile CountDownLatch latch = new CountDownLatch(1);

    /**
     * Mark that the game state changed: wake every long-poll waiting for a change.
     * Call it after the change is visible to the state fetcher.
     */
    @Override
    public synchronized void markDirty() {
        CountDownLatch released = latch;
        latch = new CountDownLatch(1);
        released.countDown();
    }

    /**
     * Mark the content as gone for good and wake every waiting long-poll.
     */
    @Override
    public void setCompleted() {
        super.setCompleted();
        markDirty();
    }

    /**
     * A watcher for one long-poll request. Create it before the request's hash is compared, that is
     * before calling {@code ResultGenerator.getStringResult}, and hand it to that call.
     *
     * @return watcher that wakes on any change after this call
     */
    public ContentWatcher forOnePoll() {
        final CountDownLatch seen = latch;
        final GameStateWatcher game = this;
        return new ContentWatcher() {
            @Override
            protected boolean awaitUpdate(long timeout) {
                return !isCompleted() && awaitLatch(seen, timeout);
            }

            @Override
            public boolean isCompleted() {
                return game.isCompleted();
            }
        };
    }

    @Override
    protected boolean awaitUpdate(long timeout) {
        return !isCompleted() && awaitLatch(latch, timeout);
    }

    private static boolean awaitLatch(CountDownLatch latch, long timeout) {
        try {
            return latch.await(timeout, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}
