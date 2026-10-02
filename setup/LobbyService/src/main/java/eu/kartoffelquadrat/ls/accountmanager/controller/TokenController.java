package eu.kartoffelquadrat.ls.accountmanager.controller;

import com.google.gson.Gson;
import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import eu.kartoffelquadrat.ls.accountmanager.model.Role;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.common.OAuth2AccessToken;
import org.springframework.security.oauth2.provider.token.TokenStore;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.security.Principal;
import java.util.Collection;
import java.util.Collections;

/**
 * ToDo: Update access URLs. Controller that resolves to a user identity / role based on a passed oauth2 token.
 * <p>
 * Sample access: curl "http://127.0.0.1:8084/api/username?access_token=...="
 *
 * @author Maximilian Schiedermeier, August 2020
 */
@RestController
public class TokenController {

    @Autowired
    TokenStore tokenStore;

    @Autowired
    AuthTokenService authTokenService;

    @Autowired
    RoomTokenService roomTokenService;

    /**
     * Resolve a token to the roles of its user. This is how the game server checks a token.
     * <p>
     * A room token counts only together with {@code session}, the id of the session it was minted for, and then
     * has the player role. Without it, or for any other session, it gets the same 401 as an unknown token, so a
     * room token can never pass for its player in another game.
     */
    @GetMapping(value = "/oauth/role")
    public ResponseEntity<?> oauthRole(@RequestParam(value = "access_token", required = false) String token,
                                       @RequestParam(value = "session", required = false) String session) {
        if (roomTokenService.isRoomToken(token)) {
            if (!roomTokenService.isForRoom(token, session)) {
                return roomTokenRejected();
            }
            return ResponseEntity.ok(Collections.singletonList(new SimpleGrantedAuthority(Role.ROLE_PLAYER.toString())));
        }
        return ResponseEntity.ok(currentUserRole(token));
    }

    /**
     * Roles behind a token, for the LS's own checks. A room token only ever has {@link RoomTokenService#ROOM_AUTHORITY}
     * here, which no check accepts.
     */
    public Collection<SimpleGrantedAuthority> currentUserRole(String token) {
        if (roomTokenService.isRoomToken(token)) {
            return Collections.singletonList(new SimpleGrantedAuthority(RoomTokenService.ROOM_AUTHORITY));
        }
        Player player = authTokenService.resolve(token);
        if (player != null) {
            return Collections.singletonList(new SimpleGrantedAuthority(player.getRole().toString()));
        }
        return (Collection<SimpleGrantedAuthority>) SecurityContextHolder.getContext().getAuthentication().getAuthorities();
    }

    public Collection<SimpleGrantedAuthority> currentUserRole() {
        return (Collection<SimpleGrantedAuthority>) SecurityContextHolder.getContext().getAuthentication().getAuthorities();
    }

    /**
     * Resolve a token to its username. This is how the game server checks that a token belongs to the player
     * whose move it sends.
     * <p>
     * A room token resolves only together with {@code session}, the id of the session it was minted for. Without
     * it, or for any other session, it gets the same 401 as an unknown token.
     */
    @GetMapping(value = "/oauth/username")
    public ResponseEntity<String> currentUserName(@RequestParam(value = "access_token", required = false) String token,
                                                  @RequestParam(value = "session", required = false) String session,
                                                  Principal principal) {
        if (roomTokenService.isRoomToken(token)) {
            if (!roomTokenService.isForRoom(token, session)) {
                return roomTokenRejected();
            }
            return ResponseEntity.ok(roomTokenService.username(token));
        }
        Player player = authTokenService.resolve(token);
        if (player != null) {
            return ResponseEntity.ok(player.getName());
        }
        return ResponseEntity.ok(principal == null ? "" : principal.getName());
    }

    /** The 401 an unknown OAuth token gets, in the same JSON shape, so the GS's error handling applies unchanged. */
    private static ResponseEntity<String> roomTokenRejected() {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).contentType(MediaType.APPLICATION_JSON)
                .body("{\"error\":\"invalid_token\",\"error_description\":\"A room token is only valid for the "
                        + "session it was minted for; pass that session's id as session.\"}");
    }

    /**
     * Username behind a primary token (a player's local-auth token, the service token or an OAuth token
     * known to the DB). Room tokens resolve to "" here, so they cannot reach account endpoints, create
     * sessions or read the user's details (which include the primary token).
     */
    public String nameFromToken(String token) {
        Player player = authTokenService.resolve(token);
        return player == null ? "" : player.getName();
    }

    /**
     * Like {@link #nameFromToken(String)}, but a room token also counts, for the one session it was
     * minted for.
     */
    public String nameFromToken(String token, long sessionId) {
        if (roomTokenService.isForRoom(token, String.valueOf(sessionId))) {
            return roomTokenService.username(token);
        }
        return nameFromToken(token);
    }

    public boolean isAdminToken(String token) {
        return authTokenService.isRole(token, Role.ROLE_ADMIN);
    }

    public boolean isPlayerToken(String token) {
        return authTokenService.isRole(token, Role.ROLE_PLAYER);
    }

    @PostMapping(value = "/api/local-auth", consumes = "application/json; charset=utf-8", produces = "application/json; charset=utf-8")
    public String localAuth(@RequestBody LocalAuthForm form) {
        Player player = authTokenService.ensurePlayer(form == null ? null : form.token, form == null ? null : form.displayName);
        return new Gson().toJson(new LocalAuthResponse(player.getAuthToken(), player.getName(), authTokenService.displayName(player), player.getPreferredColour(), player.getRole().toString()));
    }

    public static class LocalAuthForm {
        public String token;
        public String displayName;
    }

    public static class LocalAuthResponse {
        public final String token;
        public final String username;
        public final String displayName;
        public final String preferredColour;
        public final String role;

        public LocalAuthResponse(String token, String username, String displayName, String preferredColour, String role) {
            this.token = token;
            this.username = username;
            this.displayName = displayName;
            this.preferredColour = preferredColour;
            this.role = role;
        }
    }

    /**
     * Endpoint to revoke an existing OAuth2 token (and the associated refresh token). Must be called on logout and user
     * deletion. Can only be called by the token owner.
     */
    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/oauth/active")
    public ResponseEntity revokeOwnTokens(Principal principal) {

        String callerName = principal.getName();
        boolean success = revokeTokensByName(callerName);
        if (success)
            return ResponseEntity.status(HttpStatus.OK).body(null);
        else
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("There are no active tokens for the requested user.");
    }

    /**
     * Method to actually discard the tokens. Is also required by Account-Controller uppon user deletion.
     *
     * @param name as the name of the user whose tokens shall be revoked.
     */
    public boolean revokeTokensByName(String name) {
        Collection<OAuth2AccessToken> adminAccessTokens = tokenStore.findTokensByClientIdAndUserName("bgp-client-name", name);
        //tokenStore.
        if (adminAccessTokens != null && !adminAccessTokens.isEmpty()) {
            for (OAuth2AccessToken accessToken : adminAccessTokens) {
                tokenStore.removeRefreshToken(accessToken.getRefreshToken());
                tokenStore.removeAccessToken(accessToken);
            }
            return true;
        } else
            return false;
    }
}
