package ca.hexanome04.splendorgame.control;

import static org.assertj.core.api.Assertions.assertThat;

import ca.hexanome04.splendorgame.control.templates.GameServiceInfo;
import ca.hexanome04.splendorgame.control.templates.LaunchSessionInfo;
import ca.hexanome04.splendorgame.control.templates.PlayerInfo;
import ca.hexanome04.splendorgame.model.action.actions.TakeTokenAction;
import ca.hexanome04.splendorgame.model.gameversions.Game;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import java.io.File;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

/**
 * The two Cities versions: BASE_ORIENT_CITIES (official rule, no nobles) and BASE_ORIENT_CITIES_NOBLES.
 */
public class CitiesVariantsTest {

    private static final List<PlayerInfo> PLAYERS = List.of(new PlayerInfo("p1", "c1"), new PlayerInfo("p2", "c2"));

    @Test
    @DisplayName("BASE_ORIENT_CITIES deals no nobles, BASE_ORIENT_CITIES_NOBLES deals them; both deal 3 cities")
    void testNoblesPerVariant() {
        SessionManager sessionManager = new SessionManager();

        CitiesGame noNobles = (CitiesGame) sessionManager.launchNewGame(GameVersions.BASE_ORIENT_CITIES, PLAYERS);
        assertThat(noNobles.getGameVersion()).isEqualTo(GameVersions.BASE_ORIENT_CITIES);
        assertThat(noNobles.getNobles()).isEmpty();
        assertThat(noNobles.getCitiesDeck().getVisibleCards()).hasSize(3);

        CitiesGame withNobles = (CitiesGame) sessionManager.launchNewGame(GameVersions.BASE_ORIENT_CITIES_NOBLES,
                PLAYERS);
        assertThat(withNobles.getGameVersion()).isEqualTo(GameVersions.BASE_ORIENT_CITIES_NOBLES);
        // the test card file only has 2 nobles; the real one deals players + 1 (see FullGameSimulationTests)
        assertThat(withNobles.getNobles()).isNotEmpty();
        assertThat(withNobles.getCitiesDeck().getVisibleCards()).hasSize(3);
    }

    @Test
    @DisplayName("Each Cities service name launches its own version (exact match, not a prefix)")
    void testLaunchByServiceName() throws Exception {
        SessionManager sessionManager = new SessionManager();
        SplendorRestController controller = new SplendorRestController(sessionManager,
                Mockito.mock(Authentication.class), Mockito.mock(GameSavesManager.class), "splendor", 1000);

        for (GameVersions version : GameVersions.values()) {
            String sessionId = "s-" + version;
            assertThat(controller.launchSession(sessionId,
                    new LaunchSessionInfo("splendor_" + version, PLAYERS, "p1", "")).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            assertThat(sessionManager.getGameSession(sessionId).getGame().getGameVersion()).isEqualTo(version);
        }
    }

    @Test
    @DisplayName("Both Cities versions survive a save and load")
    void testSaveAndLoadBothVariants() throws Exception {
        File dir = Files.createTempDirectory("splendor-cities-saves").toFile();
        GameSavesManager saves = new GameSavesManager(dir, "all.json", new SplendorTypeAdapter("splendor"));
        SessionManager sessionManager = new SessionManager();

        for (GameVersions version : List.of(GameVersions.BASE_ORIENT_CITIES, GameVersions.BASE_ORIENT_CITIES_NOBLES)) {
            Game original = sessionManager.launchNewGame(version, PLAYERS);
            original.takeAction("p1", new TakeTokenAction(new HashMap<>(), new HashMap<>()));
            String saveId = saves.createGameSave("save " + version, "p1", original);
            assertThat(saveId).isNotEmpty();
            assertThat(saves.getGameSave(saveId).gameSaveData().gamename()).isEqualTo("splendor_" + version);

            Game loaded = saves.getGameSaveData(saveId);
            assertThat(loaded).isInstanceOf(CitiesGame.class);
            assertThat(loaded.getGameVersion()).isEqualTo(version);
            assertThat(((CitiesGame) loaded).getNobles()).hasSameSizeAs(((CitiesGame) original).getNobles());
            assertThat(((CitiesGame) loaded).getCitiesDeck().getVisibleCards()).hasSize(3);
            assertThat(loaded.getTurnCounter()).isEqualTo(1);

            // the loaded game can be played on
            assertThat(loaded.takeAction("p2", new TakeTokenAction(new HashMap<>(), new HashMap<>())))
                    .isNotEmpty();
            assertThat(loaded.getTurnCounter()).isEqualTo(0);
        }
    }

    @Test
    @DisplayName("The Lobby Service registrations use display names that cannot collide")
    void testServiceRegistrations() {
        Initializer initializer = new Initializer(Mockito.mock(Authentication.class),
                Mockito.mock(GameSaveInitializer.class), "splendor", "Splendor", "http://127.0.0.1:1");
        GameServiceInfo[] services = initializer.gameServices;

        assertThat(services).extracting(GameServiceInfo::name).containsExactly("splendor_BASE_ORIENT",
                "splendor_BASE_ORIENT_CITIES", "splendor_BASE_ORIENT_CITIES_NOBLES",
                "splendor_BASE_ORIENT_TRADE_ROUTES");
        assertThat(services).extracting(GameServiceInfo::displayName).containsExactly("Splendor Orient",
                "Splendor Cities", "Splendor Nobles and Cities", "Splendor Trade Routes");

        // the Lobby Service refuses a display name that is contained in an already registered one,
        // so no display name may contain another, whatever the registration order
        for (GameServiceInfo a : services) {
            assertThat(a.minSessionPlayers()).isEqualTo(2);
            assertThat(a.maxSessionPlayers()).isEqualTo(4);
            for (GameServiceInfo b : services) {
                if (a != b) {
                    assertThat(a.displayName()).doesNotContain(b.displayName());
                }
            }
        }
    }
}
