package eu.kartoffelquadrat.ls.accountmanager.controller;

import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** Room-scoped migrate tokens that do not expose the user's primary auth token. */
@Service
public class RoomTokenService {
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

    public String username(String token) {
        RoomIdentity identity = identities.get(token);
        return identity == null ? "" : identity.username;
    }

    public boolean isForRoom(String token, String roomId) {
        RoomIdentity identity = identities.get(token);
        return identity != null && identity.roomId.equals(roomId);
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
