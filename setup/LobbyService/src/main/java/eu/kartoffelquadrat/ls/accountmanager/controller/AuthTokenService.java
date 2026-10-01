package eu.kartoffelquadrat.ls.accountmanager.controller;

import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import eu.kartoffelquadrat.ls.accountmanager.model.PlayerRepository;
import eu.kartoffelquadrat.ls.accountmanager.model.Role;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

/** Local intranet token auth used by the self-hosted client. */
@Service
public class AuthTokenService {
    private static final Logger LOGGER = LoggerFactory.getLogger(AuthTokenService.class);
    private static final String TOKEN_PREFIX = "selfhost_";
    /** Environment variable that holds the secret service token (self_host.py generates one). */
    public static final String SERVICE_TOKEN_ENV = "SPLENDOR_SERVICE_TOKEN";
    /** Old hard-coded token. It is public, so it is only used when the variable is unset. */
    private static final String LEGACY_SERVICE_TOKEN = "selfhost_service_token";
    private static final String SERVICE_ACCOUNT = "xox";
    private static final SecureRandom RNG = new SecureRandom();

    private final String serviceToken;

    @Autowired
    private PlayerRepository playerRepository;

    /**
     * Hashes a token into the account's OAuth password. The plain token is stored in the same row
     * (authToken), so a slow hash protects nothing here, while the shared cost-12 encoder made every
     * unauthenticated POST /api/local-auth with a new token burn about half a CPU second. Cost 4 is
     * BCrypt's minimum; the shared encoder still verifies these hashes because BCrypt reads the cost
     * from the hash.
     */
    private static final BCryptPasswordEncoder TOKEN_HASHER = new BCryptPasswordEncoder(4, RNG);

    public AuthTokenService() {
        String configured = System.getenv(SERVICE_TOKEN_ENV);
        if (configured == null || configured.trim().isEmpty()) {
            LOGGER.warn("**********************************************************************");
            LOGGER.warn("{} is not set. Falling back to the PUBLIC legacy service token.", SERVICE_TOKEN_ENV);
            LOGGER.warn("Anyone who can reach this Lobby Service can then act as the game service:");
            LOGGER.warn("unregister games, delete running sessions, register fake services.");
            LOGGER.warn("Set {} to a random secret (./self_host.py does this for you).", SERVICE_TOKEN_ENV);
            LOGGER.warn("**********************************************************************");
            serviceToken = LEGACY_SERVICE_TOKEN;
        } else {
            serviceToken = configured.trim();
            if (!serviceToken.startsWith(TOKEN_PREFIX)) {
                LOGGER.warn("{} does not start with \"{}\". The game server only uses a password with that "
                        + "prefix directly as its token.", SERVICE_TOKEN_ENV, TOKEN_PREFIX);
            }
        }
    }

    /** Rotate the stored service account to the current token at startup, so an old token stops working. */
    @EventListener(ApplicationReadyEvent.class)
    public void syncServiceAccount() {
        ensureServiceAccount();
    }

    public String serviceToken() {
        ensureServiceAccount();
        return serviceToken;
    }

    public Player ensureServiceAccount() {
        Optional<Player> existing = playerRepository.findById(SERVICE_ACCOUNT);
        if (existing.isPresent()) {
            Player player = existing.get();
            boolean changed = false;
            if (player.getRole() != Role.ROLE_SERVICE) {
                player.setRole(Role.ROLE_SERVICE);
                changed = true;
            }
            if (!serviceToken.equals(player.getAuthToken())) {
                // The token was rotated. Replace the stored token and the OAuth password (bcrypt of the token).
                player.setAuthToken(serviceToken);
                player.setPassword(TOKEN_HASHER.encode(serviceToken));
                changed = true;
                LOGGER.info("Service account token updated from {}.", SERVICE_TOKEN_ENV);
            }
            return changed ? playerRepository.save(player) : player;
        }
        Player player = new Player(SERVICE_ACCOUNT, "FFFFFF", TOKEN_HASHER.encode(serviceToken), Role.ROLE_SERVICE);
        player.setAuthToken(serviceToken);
        player.setDisplayName("Service");
        return playerRepository.save(player);
    }

    public Player resolve(String token) {
        if (token == null || token.trim().isEmpty()) {
            return null;
        }
        if (serviceToken.equals(token)) {
            return ensureServiceAccount();
        }
        Player player = playerRepository.findByAuthToken(token).orElse(null);
        // Service rights come only from the configured token, never from a stale stored one.
        if (player != null && player.getRole() == Role.ROLE_SERVICE) {
            return null;
        }
        return player;
    }

    public boolean isRole(String token, Role role) {
        Player player = resolve(token);
        return player != null && player.getRole() == role;
    }

    public Player ensurePlayer(String token, String displayName) {
        if (token == null || token.trim().isEmpty()) {
            token = generateToken();
        }
        Optional<Player> existing = playerRepository.findByAuthToken(token);
        if (existing.isPresent()) {
            Player player = existing.get();
            if (displayName != null && !displayName.trim().isEmpty()
                    && (player.getDisplayName() == null || player.getDisplayName().trim().isEmpty())) {
                player.setDisplayName(displayName.trim());
                playerRepository.save(player);
            }
            return player;
        }

        String cleanDisplay = cleanDisplayName(displayName);
        String base = slug(cleanDisplay);
        String username = uniqueUsername(base);
        Player player = new Player(username, randomColour(), TOKEN_HASHER.encode(token), Role.ROLE_PLAYER);
        player.setAuthToken(token);
        player.setDisplayName(cleanDisplay);
        return playerRepository.save(player);
    }

    public String displayName(Player player) {
        if (player == null) {
            return "";
        }
        String displayName = player.getDisplayName();
        return displayName == null || displayName.trim().isEmpty() ? player.getName() : displayName;
    }

    private String cleanDisplayName(String displayName) {
        String cleaned = displayName == null ? "Player" : displayName.trim();
        if (cleaned.isEmpty()) {
            cleaned = "Player";
        }
        return cleaned.length() > 40 ? cleaned.substring(0, 40) : cleaned;
    }

    private String slug(String value) {
        String slug = value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
        if (slug.isEmpty()) {
            slug = "player";
        }
        return slug;
    }

    private String uniqueUsername(String base) {
        String candidate = base;
        int i = 2;
        while (playerRepository.existsById(candidate)) {
            candidate = base + "_" + i;
            i++;
        }
        return candidate;
    }

    private String randomColour() {
        int value = RNG.nextInt(0x1000000);
        return String.format("%06X", value);
    }

    private String generateToken() {
        byte[] bytes = new byte[24];
        RNG.nextBytes(bytes);
        StringBuilder out = new StringBuilder(TOKEN_PREFIX);
        for (byte b : bytes) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }
}
