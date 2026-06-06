package eu.kartoffelquadrat.ls.accountmanager.controller;

import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import eu.kartoffelquadrat.ls.accountmanager.model.PlayerRepository;
import eu.kartoffelquadrat.ls.accountmanager.model.Role;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

/** Local intranet token auth used by the self-hosted client. */
@Service
public class AuthTokenService {
    private static final String TOKEN_PREFIX = "selfhost_";
    private static final String SERVICE_TOKEN = "selfhost_service_token";
    private static final SecureRandom RNG = new SecureRandom();

    @Autowired
    private PlayerRepository playerRepository;

    @Autowired
    private BCryptPasswordEncoder passwordEncoder;

    public String serviceToken() {
        ensureServiceAccount();
        return SERVICE_TOKEN;
    }

    public Player ensureServiceAccount() {
        Optional<Player> existing = playerRepository.findById("xox");
        if (existing.isPresent()) {
            Player player = existing.get();
            if (player.getRole() != Role.ROLE_SERVICE) {
                player.setRole(Role.ROLE_SERVICE);
                playerRepository.save(player);
            }
            return player;
        }
        Player player = new Player("xox", "FFFFFF", passwordEncoder.encode(SERVICE_TOKEN), Role.ROLE_SERVICE);
        player.setAuthToken(SERVICE_TOKEN);
        player.setDisplayName("Service");
        return playerRepository.save(player);
    }

    public Player resolve(String token) {
        if (token == null || token.trim().isEmpty()) {
            return null;
        }
        if (SERVICE_TOKEN.equals(token)) {
            return ensureServiceAccount();
        }
        return playerRepository.findByAuthToken(token).orElse(null);
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
        Player player = new Player(username, randomColour(), passwordEncoder.encode(token), Role.ROLE_PLAYER);
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
