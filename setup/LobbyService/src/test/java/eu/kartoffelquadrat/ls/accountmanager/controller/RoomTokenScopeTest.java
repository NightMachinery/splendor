package eu.kartoffelquadrat.ls.accountmanager.controller;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import eu.kartoffelquadrat.ls.accountmanager.model.Role;
import java.util.Collection;
import org.junit.Before;
import org.junit.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/**
 * A room token stands for its player in the one session it was minted for, and nowhere else. The game server
 * learns who a token belongs to only through /oauth/username and /oauth/role, so those must refuse a room token
 * that is used without its session or in another one.
 */
public class RoomTokenScopeTest {

    private static final String PRIMARY = "primary-token-of-victim";

    private RoomTokenService rooms;
    private TokenController controller;

    @Before
    public void setUp() {
        rooms = new RoomTokenService();
        AuthTokenService auth = mock(AuthTokenService.class);
        when(auth.resolve(PRIMARY)).thenReturn(new Player("victim", "FFFFFF", "x", Role.ROLE_PLAYER));
        controller = new TokenController();
        controller.roomTokenService = rooms;
        controller.authTokenService = auth;
    }

    @Test
    public void usernameResolvesOnlyForTheTokensOwnSession() {
        String token = rooms.create("111", "victim");

        assertOk("victim", controller.currentUserName(token, "111", null));
        assertRejected(controller.currentUserName(token, "222", null));
        assertRejected(controller.currentUserName(token, null, null));
        assertRejected(controller.currentUserName(token, "", null));
    }

    @Test
    public void roleIsPlayerOnlyForTheTokensOwnSession() {
        String token = rooms.create("111", "victim");

        ResponseEntity<?> own = controller.oauthRole(token, "111");
        assertEquals(HttpStatus.OK, own.getStatusCode());
        assertEquals("[ROLE_PLAYER]", own.getBody().toString());
        assertRejected(controller.oauthRole(token, "222"));
        assertRejected(controller.oauthRole(token, null));
    }

    @Test
    public void primaryTokensIgnoreTheSessionParameter() {
        assertOk("victim", controller.currentUserName(PRIMARY, null, null));
        assertOk("victim", controller.currentUserName(PRIMARY, "222", null));
        assertEquals("[ROLE_PLAYER]", controller.oauthRole(PRIMARY, "222").getBody().toString());
    }

    @Test
    public void lsChecksNeverSeeARoomTokenAsAPlayer() {
        String token = rooms.create("111", "victim");

        Collection<SimpleGrantedAuthority> roles = controller.currentUserRole(token);
        assertEquals("[" + RoomTokenService.ROOM_AUTHORITY + "]", roles.toString());
        assertEquals("", controller.nameFromToken(token));
        assertEquals("victim", controller.nameFromToken(token, 111L));
        assertEquals("", controller.nameFromToken(token, 222L));
    }

    @Test
    public void deletingASessionRevokesItsRoomTokens() {
        String a = rooms.create("111", "victim");
        String b = rooms.create("111", "carol");
        String other = rooms.create("222", "victim");

        rooms.revokeRoom("111");

        assertFalse(rooms.isRoomToken(a));
        assertFalse(rooms.isRoomToken(b));
        assertTrue(rooms.isForRoom(other, "222"));
        // A revoked token is just an unknown token now; it is no longer special-cased as a room token.
        assertEquals("", rooms.username(a));
        assertEquals("", controller.nameFromToken(a, 111L));
    }

    @Test
    public void leavingASessionRevokesOnlyThatPlayersTokensThere() {
        String victimHere = rooms.create("111", "victim");
        String carolHere = rooms.create("111", "carol");
        String victimElsewhere = rooms.create("222", "victim");

        rooms.revoke("111", "victim");

        assertFalse(rooms.isRoomToken(victimHere));
        assertTrue(rooms.isForRoom(carolHere, "111"));
        assertTrue(rooms.isForRoom(victimElsewhere, "222"));
    }

    @Test
    public void nullTokensAndRoomsAreHarmless() {
        assertFalse(rooms.isRoomToken(null));
        assertFalse(rooms.isForRoom(null, "111"));
        assertFalse(rooms.isForRoom(rooms.create("111", "victim"), null));
        assertEquals("", rooms.username(null));
    }

    private static void assertOk(String expected, ResponseEntity<String> response) {
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(expected, response.getBody());
    }

    private static void assertRejected(ResponseEntity<?> response) {
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody()).contains("\"error\":\"invalid_token\""));
    }
}
