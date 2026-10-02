package eu.kartoffelquadrat.ls.accountmanager.controller;

import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/**
 * Room-scoped migrate tokens that do not expose the user's primary auth token.
 *
 * <p>A room token stands for one player in one session (room) and is worth nothing anywhere else: every lookup
 * that resolves it to the player also names the session it is used for (see {@link #isForRoom}). Tokens live in
 * memory only. They are revoked when their session is deleted or their player leaves it, so a session id that
 * is ever reused cannot inherit them.
 */
@Service
public class RoomTokenService {
    /** Authority of a room token in the security context. No @PreAuthorize role check accepts it. */
    public static final String ROOM_AUTHORITY = "ROLE_ROOM";
    /** Principal name prefix for room tokens; ':' never occurs in a username, so it never matches one. */
    public static final String PRINCIPAL_PREFIX = "room:";
    private static final SecureRandom RNG = new SecureRandom();
    private final Map<String, RoomIdentity> identities = new ConcurrentHashMap<>();

    public String create(String roomId, String username) {
        String token;
        do {
            token = generateToken();
        } while (identities.containsKey(token));
        identities.put(token, new RoomIdentity(roomId, username));
        return token;
    }

    /** Whether token is a live room token, for any room. */
    public boolean isRoomToken(String token) {
        return token != null && identities.containsKey(token);
    }

    /**
     * The player a room token stands for, or "" for anything else. This alone does not say which session the
     * token may act in; callers that grant anything must also check {@link #isForRoom}.
     */
    public String username(String token) {
        RoomIdentity identity = token == null ? null : identities.get(token);
        return identity == null ? "" : identity.username;
    }

    public boolean isForRoom(String token, String roomId) {
        RoomIdentity identity = token == null ? null : identities.get(token);
        return identity != null && roomId != null && identity.roomId.equals(roomId);
    }

    /** Forget every room token minted for roomId (the session was deleted). */
    public void revokeRoom(String roomId) {
        identities.values().removeIf(identity -> identity.roomId.equals(roomId));
    }

    /** Forget the room tokens of one player in roomId (the player left the session). */
    public void revoke(String roomId, String username) {
        identities.values().removeIf(identity -> identity.roomId.equals(roomId) && identity.username.equals(username));
    }

    private String generateToken() {
        byte[] bytes = new byte[24];
        RNG.nextBytes(bytes);
        StringBuilder out = new StringBuilder("room_");
        for (byte b : bytes) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }

    private static class RoomIdentity {
        final String roomId;
        final String username;

        RoomIdentity(String roomId, String username) {
            this.roomId = roomId;
            this.username = username;
        }
    }
}
