package eu.kartoffelquadrat.ls.lobby.model;

import eu.kartoffelquadrat.asyncrestlib.BroadcastContent;
import eu.kartoffelquadrat.ls.gameregistry.controller.LocationValidator;
import eu.kartoffelquadrat.ls.gameregistry.model.GameServerParameters;
import eu.kartoffelquadrat.ls.lobby.control.SessionException;

import java.util.*;

/**
 * Represents a session as maintained by the BGP. Sessions bind players together for a specific game. The lifecycle is
 * opened, launched, removed. OR opened, removed.
 */
public class Session implements BroadcastContent {

    private final GameServerParameters gameParameters;
    private final String creator;
    private final LinkedList<String> players;
    private boolean launched;
    private final Map<String, String> displayNames;
    private final Map<String, String> displayAliases;
    private final Set<String> observers;
    private final Set<String> mods;
    private final Set<String> tempMods;
    private long noRealModSince;

    // savegameid is optional. Only relevant, if the session originates a registered savegame.
    private String savegameid;

    // playerLocations is optional. Only relevant if the gameserver registered in P2P mode. Can not replace original players list, for the order in the players-list is relevant.
    // Note: this map is not filled by constructor, but through an additional addPlayerLocation call.
    private Map<String, String> playerLocations;

    /**
     * Constructor to create a standard session (not originating a savegame).
     * @param creator
     * @param gameParameters
     */
    public Session(String creator, GameServerParameters gameParameters) {
        this.creator = creator;
        this.gameParameters = gameParameters;
        players = new LinkedList<>();
        players.add(creator);
        launched = false;
        playerLocations = new LinkedHashMap<>();
        displayNames = new LinkedHashMap<>();
        displayAliases = new LinkedHashMap<>();
        observers = new LinkedHashSet<>();
        mods = new LinkedHashSet<>();
        tempMods = new LinkedHashSet<>();
        noRealModSince = 0;
        mods.add(creator);
    }

    /**
     * Constructor to create a branded session from a savegame.
     * @param gameParameters
     * @param creator
     * @param savegameid
     */
    public Session(String creator, GameServerParameters gameParameters, String savegameid) {
        this.gameParameters = gameParameters;
        this.creator = creator;
        this.players = new LinkedList<>();
        players.add(creator);
        this.savegameid = savegameid;
        launched = false;
        playerLocations = new LinkedHashMap<>();
        displayNames = new LinkedHashMap<>();
        displayAliases = new LinkedHashMap<>();
        observers = new LinkedHashSet<>();
        mods = new LinkedHashSet<>();
        tempMods = new LinkedHashSet<>();
        noRealModSince = 0;
        mods.add(creator);
    }

    /**
     * Registers a player location (IP). Only relevant if the associated game server is registered as P2P phantom.
     * @param player must be a registered player.
     * @param location must be a valid IP address.
     */
    public void addPlayerLocation(String player, String location) throws SessionException {

        if(!players.contains(player))
            throw new SessionException("Player locator can not be added. The player is not registered to this session.");

        if(!LocationValidator.isValidClientLocation(location))
            throw new SessionException("Player locator can not be added. The provided location is not a valid IP address.");

        playerLocations.put(player, location);
    }

    public boolean isFull() {
        return players.size() >= gameParameters.getMaxSessionPlayers();
    }

    public String getGameName() {
        return gameParameters.getName();
    }

    public String getCreator() {
        return creator;
    }

    public List<String> getPlayers() {
        return Collections.unmodifiableList(players);
    }

    public Map<String, String> getDisplayNames() {
        return Collections.unmodifiableMap(displayAliases);
    }

    public Set<String> getObservers() {
        return Collections.unmodifiableSet(observers);
    }

    public List<String> getActivePlayers() {
        List<String> active = new LinkedList<>();
        for (String player : players) {
            if (!observers.contains(player)) {
                active.add(player);
            }
        }
        return active;
    }

    public Set<String> getMods() {
        return Collections.unmodifiableSet(mods);
    }

    public Set<String> getTempMods() {
        return Collections.unmodifiableSet(tempMods);
    }

    public void setDisplayName(String player, String displayName) {
        displayNames.put(player, displayName == null || displayName.trim().isEmpty() ? player : displayName.trim());
        rebuildAliases();
    }

    private void rebuildAliases() {
        displayAliases.clear();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String player : players) {
            String base = displayNames.getOrDefault(player, player);
            int next = counts.getOrDefault(base, 0) + 1;
            counts.put(base, next);
            displayAliases.put(player, next == 1 ? base : base + " " + next);
        }
    }

    public boolean isMod(String player) {
        updateTempMods();
        return creator.equals(player) || mods.contains(player);
    }

    public void promoteMod(String player) {
        if (players.contains(player)) {
            mods.add(player);
        }
    }

    public void promoteTempMod(String player) {
        if (players.contains(player)) {
            mods.add(player);
            tempMods.add(player);
        }
    }

    public void updateTempMods() {
        if (hasRealMod()) {
            mods.removeAll(tempMods);
            noRealModSince = 0;
            return;
        }
        long now = System.currentTimeMillis();
        if (noRealModSince == 0) {
            noRealModSince = now;
            return;
        }
        if (now - noRealModSince < 300000 || !mods.isEmpty()) {
            return;
        }
        for (String player : players) {
            if (tempMods.contains(player)) {
                mods.add(player);
                return;
            }
        }
        if (!players.isEmpty()) {
            String player = players.get(new Random().nextInt(players.size()));
            tempMods.add(player);
            mods.add(player);
        }
    }

    private boolean hasRealMod() {
        for (String mod : mods) {
            if (!tempMods.contains(mod)) {
                return true;
            }
        }
        return false;
    }

    public void demoteMod(String player) {
        if (!creator.equals(player)) {
            mods.remove(player);
        }
    }

    public void setObserver(String player, boolean observer) {
        if (observer) {
            observers.add(player);
        } else {
            observers.remove(player);
        }
    }

    public void addPlayer(String playerid) {
        if (isFull())
            throw new RuntimeException("Player cannot be added to session. Session is already full.");
        players.add(playerid);
        rebuildAliases();
    }

    public boolean isLaunched() {
        return launched;
    }

    public void markAsLaunched() {
        if (launched)
            throw new RuntimeException("Session cannot be marked as launched, because is it already launched.");
        launched = true;
    }

    public void removePlayer(String player) {
        if(!players.contains(player))
            throw new RuntimeException("Player can not be removed, because she is not registered to the session.");
        players.remove(player);
        observers.remove(player);
        mods.remove(player);
        tempMods.remove(player);
        rebuildAliases();
    }

    public GameServerParameters getGameParameters() {
        return gameParameters;
    }

    public String getSavegameid() {
        return savegameid;
    }

    @Override
    public boolean isEmpty() {
        return false;
    }
}
