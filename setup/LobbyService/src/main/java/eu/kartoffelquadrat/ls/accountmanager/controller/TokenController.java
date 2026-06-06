package eu.kartoffelquadrat.ls.accountmanager.controller;

import com.google.gson.Gson;
import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import eu.kartoffelquadrat.ls.accountmanager.model.Role;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
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
     * Resolve logged in user back to her roles, based on token
     */
    @GetMapping(value = "/oauth/role")
    public Collection<SimpleGrantedAuthority> currentUserRole(@RequestParam(value = "access_token", required = false) String token) {
        String roomUser = roomTokenService.username(token);
        if (!roomUser.isEmpty()) {
            return java.util.Collections.singletonList(new SimpleGrantedAuthority(Role.ROLE_PLAYER.toString()));
        }
        Player player = authTokenService.resolve(token);
        if (player != null) {
            return java.util.Collections.singletonList(new SimpleGrantedAuthority(player.getRole().toString()));
        }
        return (Collection<SimpleGrantedAuthority>) SecurityContextHolder.getContext().getAuthentication().getAuthorities();
    }

    public Collection<SimpleGrantedAuthority> currentUserRole() {
        return (Collection<SimpleGrantedAuthority>) SecurityContextHolder.getContext().getAuthentication().getAuthorities();
    }

    /**
     * Resolve logged in user back to username based on token
     */
    @GetMapping(value = "/oauth/username")
    public String currentUserName(@RequestParam(value = "access_token", required = false) String token, Principal principal) {
        String roomUser = roomTokenService.username(token);
        if (!roomUser.isEmpty()) {
            return roomUser;
        }
        Player player = authTokenService.resolve(token);
        if (player != null) {
            return player.getName();
        }
        return principal == null ? "" : principal.getName();
    }

    public String nameFromToken(String token) {
        String roomUser = roomTokenService.username(token);
        if (!roomUser.isEmpty()) {
            return roomUser;
        }
        Player player = authTokenService.resolve(token);
        return player == null ? "" : player.getName();
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
