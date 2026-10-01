package ca.hexanome04.splendorgame.control;

import static org.assertj.core.api.AssertionsForClassTypes.assertThat;
import static org.junit.jupiter.api.Assertions.assertNull;
import static ca.hexanome04.splendorgame.model.gameversions.GameVersions.*;
import ca.hexanome04.splendorgame.control.templates.*;
import ca.hexanome04.splendorgame.model.Deck;
import ca.hexanome04.splendorgame.model.DevelopmentCard;
import ca.hexanome04.splendorgame.model.GameSession;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Test for class SessionManager.
 */
public class SessionManagerTest {

    private final SessionManager dummySessionManager = new SessionManager();
    private final String dummyID = "id";
    private final PlayerInfo p1 = new PlayerInfo("p1", "red");
    private final PlayerInfo p2 = new PlayerInfo("p2", "blue");

    /**
     * Verify add session.
     *
     * @throws Exception Throws exception if adding session fails
     */
    @Test
    @DisplayName("Verify add session")
    public void testAddSession() throws Exception {
        ArrayList<PlayerInfo> players = new ArrayList<>();
        players.add(p1);
        players.add(p2);
        GameSession game1 = dummySessionManager.createNewSession(dummyID, players, "creator", "sessionName", BASE_ORIENT);
        assertThat(game1).isInstanceOf(GameSession.class);
        // Wrong number of players
        assertThatThrownBy(() -> {
            dummySessionManager.createNewSession(dummyID, null, "creator", "sessionName", BASE_ORIENT);
        }).isInstanceOf(Exception.class);

        // Repeated sessionID
        assertThatThrownBy(() -> {
            dummySessionManager.createNewSession(dummyID, players, "creator", "sessionName", BASE_ORIENT);
        }).isInstanceOf(Exception.class);
    }

    /**
     * Verify get session.
     *
     * @throws Exception Throws exception if adding session fails
     */
    @Test
    @DisplayName("Verify get session")
    public void testGetGameSession() throws Exception {
        // Session not found
        assertNull(dummySessionManager.getGameSession("wrongID"));

        // Session found
        ArrayList<PlayerInfo> players = new ArrayList<>();
        players.add(p1);
        players.add(p2);
        dummySessionManager.createNewSession(dummyID, players, "creator", "sessionName", BASE_ORIENT);
        assertThat(dummySessionManager.getGameSession(dummyID)).isInstanceOf(GameSession.class);
    }

    /**
     * The gs.shuffleSeed property makes every new game deal the same board, and a bad value fails fast.
     */
    @Test
    @DisplayName("gs.shuffleSeed gives reproducible deals and rejects a non-numeric seed")
    public void testShuffleSeed() {
        List<PlayerInfo> players = List.of(p1, p2);
        for (GameVersions version : GameVersions.values()) {
            SessionManager first = new SessionManager();
            first.setShuffleSeed(" 42 ");
            SessionManager second = new SessionManager();
            second.setShuffleSeed("42");
            assertThat(deal((OrientGame) first.launchNewGame(version, players)))
                    .isEqualTo(deal((OrientGame) second.launchNewGame(version, players)));
            // the same manager deals the same board again for the next game
            assertThat(deal((OrientGame) first.launchNewGame(version, players)))
                    .isEqualTo(deal((OrientGame) second.launchNewGame(version, players)));
        }

        // the seed matters: another seed deals another board (deterministic, both are seeded)
        SessionManager other = new SessionManager();
        other.setShuffleSeed("7");
        SessionManager again = new SessionManager();
        again.setShuffleSeed("42");
        assertThat(deal((OrientGame) other.launchNewGame(BASE_ORIENT, players)))
                .isNotEqualTo(deal((OrientGame) again.launchNewGame(BASE_ORIENT, players)));

        SessionManager unseeded = new SessionManager();
        unseeded.setShuffleSeed("");
        unseeded.setShuffleSeed(null);
        assertThat(unseeded.launchNewGame(BASE_ORIENT, players)).isInstanceOf(OrientGame.class);

        assertThatThrownBy(() -> new SessionManager().setShuffleSeed("abc"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("gs.shuffleSeed");
    }

    /** Visible card ids of every development deck, in order, then the nobles (the test decks are all visible). */
    private static List<String> deal(OrientGame game) {
        List<String> ids = new ArrayList<>();
        for (Deck<? extends DevelopmentCard> deck : game.getDevelopmentDecks()) {
            deck.getVisibleCards().forEach(c -> ids.add(c.getId()));
            ids.add("|");
        }
        game.getNobles().forEach(c -> ids.add(c.getId()));
        return ids;
    }
}
