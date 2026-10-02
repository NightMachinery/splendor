package ca.hexanome04.splendorgame.model.gameversions.orient;

import static ca.hexanome04.splendorgame.model.TokenType.*;

import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.*;
import java.io.*;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.util.ResourceUtils;


/**
 * Class that represents the current state of a base game + orient game.
 *
 * <p>A turn is one main action (BUY_CARD, TAKE_TOKEN or RESERVE_CARD) followed by the follow-up actions it causes
 * (cascades, satchel colour, reserving a noble, Trading Posts extra token). Once no follow-up is left, the end of
 * turn checks run: at most one noble visit, then expansion specific checks (Trading Posts powers, Cities), then the
 * player is recorded as a potential winner if they reached the target. When the last player of the round finishes
 * and someone reached the target, the game ends, so every player has had the same number of turns.</p>
 */
public class OrientGame implements Game {

    /**
     * Value of the turn counter once the game is over (kept for compatibility with existing clients).
     */
    public static final int GAME_OVER_TURN_COUNTER = -10000;

    private static final String cardsFilename = "classpath:cards.csv";

    static final Logger logger = LoggerFactory.getLogger(OrientGame.class);

    // not final: Gson sets these fields when it loads a save, and JDK 26 and later refuse to set final fields that way
    private GameVersions gameVersion;
    private int prestigePointsToWin;
    private int turnCounter;

    private List<Actions> curValidActions = new ArrayList<>();

    private List<Player> players = new ArrayList<>();

    /** Board decks. */
    private Deck<RegDevelopmentCard> tier1Deck = new Deck<>();
    private Deck<RegDevelopmentCard> tier2Deck = new Deck<>();
    private Deck<RegDevelopmentCard> tier3Deck = new Deck<>();
    private Deck<OrientDevelopmentCard> tier1OrientDeck;
    private Deck<OrientDevelopmentCard> tier2OrientDeck;
    private Deck<OrientDevelopmentCard> tier3OrientDeck;
    private Deck<NobleCard> nobleDeck;
    private HashMap<TokenType, Integer> tokens = new HashMap<>();

    /** End of game info. */
    private List<Player> playersWhoCanWin = new ArrayList<>();
    private List<Player> winners = new ArrayList<>();
    private boolean gameOver = false;

    /** Whether the current player already received a noble this turn (official rule: at most one per turn). */
    private boolean nobleVisitedThisTurn = false;

    /** Source of randomness for shuffling (null means unseeded); never saved or sent to clients. */
    private transient Random shuffleRandom;

    /** Card file to load (null means the default classpath resource); never saved or sent to clients. */
    private transient String cardsResource;


    /**
     * Creates a Splendor Game with the board state, number of prestige points to win and ordered player list.
     *
     * @param prestigePointsToWin The amount of prestige points needed to win the game.
     * @param turnCounter         The turn id associated with the player.
     */
    public OrientGame(int prestigePointsToWin, int turnCounter) {
        this(GameVersions.BASE_ORIENT, prestigePointsToWin, turnCounter);
    }

    /**
     * Creates a Splendor Game with the board state, number of prestige points to win and ordered player list.
     *
     * @param gameVersion         The game version of this game instance.
     * @param prestigePointsToWin The amount of prestige points needed to win the game.
     * @param turnCounter         The turn id associated with the player.
     */
    public OrientGame(GameVersions gameVersion, int prestigePointsToWin, int turnCounter) {
        this.gameVersion = gameVersion;
        this.prestigePointsToWin = prestigePointsToWin;
        this.turnCounter = turnCounter;

        curValidActions.add(Actions.BUY_CARD);
        curValidActions.add(Actions.TAKE_TOKEN);
        curValidActions.add(Actions.RESERVE_CARD);
    }

    /**
     * Use a specific card file instead of the default {@code classpath:cards.csv} (for tests and tools).
     * Must be called before {@link #createSplendorBoard()}.
     *
     * @param resource Spring resource location, such as {@code classpath:cards.csv} or {@code file:/path/cards.csv}
     */
    public void setCardsResource(String resource) {
        this.cardsResource = resource;
    }

    /**
     * Read a card file line by line, skipping the header and blank lines.
     *
     * @param resource Spring resource location
     * @return the data lines split on commas
     */
    protected static List<String[]> readCardFile(String resource) {
        List<String[]> rows = new ArrayList<>();
        try (InputStream inputStream = ResourceUtils.getURL(resource).openStream();
             BufferedReader br = new BufferedReader(new InputStreamReader(inputStream, Charset.defaultCharset()))) {
            String line = br.readLine(); // header
            while ((line = br.readLine()) != null) {
                if (!line.isBlank()) {
                    rows.add(line.split(","));
                }
            }
        } catch (IOException e) {
            logger.error("Could not read card file {}", resource, e);
            throw new IllegalStateException("Could not read card file " + resource, e);
        }
        return rows;
    }

    /**
     * Constructor for the splendorBoard, initializes all the decks with cards from a file.
     */
    @Override
    public void createSplendorBoard() {
        nobleDeck = new Deck<>();
        tier1OrientDeck = new Deck<>();
        tier2OrientDeck = new Deck<>();
        tier3OrientDeck = new Deck<>();

        String resource = cardsResource == null ? cardsFilename : cardsResource;
        TokenType[] types = {White, Blue, Green, Red, Brown};
        for (String[] card : readCardFile(resource)) {
            try {
                addCardFromRow(card, types);
            } catch (RuntimeException e) {
                logger.error("Malformed card line in {}: {}", resource, String.join(",", card), e);
                throw new IllegalStateException("Malformed card line in " + resource + ": " + String.join(",", card), e);
            }
        }
    }

    private void addCardFromRow(String[] card, TokenType[] types) {
        String[] cost = card[4].split(";");
        HashMap<TokenType, Integer> tokenCost = new HashMap<>();
        for (TokenType tokenType : TokenType.values()) {
            tokenCost.put(tokenType, 0);
        }

        for (int i = 0; i < 5; i++) {
            if (!cost[i].equals("0")) {
                tokenCost.put(types[i], Integer.parseInt(cost[i]));
            }
        }

        int prestigePoints = Integer.parseInt(card[2]);
        TokenType tokenType = null;
        int bonusCount = Integer.parseInt(card[1]);
        CostType costType = Enum.valueOf(CostType.class, card[3]);
        if (!card[0].isBlank()) {
            tokenType = Enum.valueOf(TokenType.class, card[0]);
        }

        String cardId = card[6];
        boolean isSatchel = tokenType == Satchel;
        boolean hasCascade = card.length > 7 && !card[7].isBlank();
        boolean hasReserveNoble = card.length > 8 && !card[8].isBlank();

        switch (card[5]) {
            case "1" -> tier1Deck.add(new RegDevelopmentCard(CardTier.TIER_1, tokenType, bonusCount,
                    prestigePoints, costType, tokenCost, cardId));

            case "2" -> tier2Deck.add(new RegDevelopmentCard(CardTier.TIER_2, tokenType, bonusCount,
                    prestigePoints, costType, tokenCost, cardId));

            case "3" -> tier3Deck.add(new RegDevelopmentCard(CardTier.TIER_3, tokenType, bonusCount,
                    prestigePoints, costType, tokenCost, cardId));

            case "N" -> nobleDeck.add(new NobleCard(prestigePoints, costType, tokenCost, cardId));

            case "O1" -> tier1OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_1, tokenType, bonusCount,
                    CascadeType.None, false, prestigePoints, costType, tokenCost, cardId, isSatchel));

            case "O2" -> {
                if (hasCascade) {
                    tier2OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_2, tokenType, bonusCount,
                            CascadeType.Tier1, false, prestigePoints, costType, tokenCost, cardId, isSatchel));
                } else if (hasReserveNoble) {
                    tier2OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_2, tokenType, bonusCount,
                            CascadeType.None, true, prestigePoints, costType, tokenCost, cardId, isSatchel));
                } else {
                    tier2OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_2, tokenType, bonusCount,
                            CascadeType.None, false, prestigePoints, costType, tokenCost, cardId, isSatchel));
                }
            }

            case "O3" -> {
                // the real card file has no tier 3 reserve-noble card, but the format allows one
                if (hasCascade) {
                    tier3OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_3, tokenType, bonusCount,
                            CascadeType.Tier2, false, prestigePoints, costType, tokenCost, cardId, isSatchel));
                } else {
                    tier3OrientDeck.add(new OrientDevelopmentCard(CardTier.TIER_3, tokenType, bonusCount,
                            CascadeType.None, hasReserveNoble, prestigePoints, costType, tokenCost, cardId, isSatchel));
                }
            }

            default -> throw new IllegalArgumentException("Unknown card row type '" + card[5] + "'");
        }
    }

    /**
     * Whether nobles are dealt at the start of this game version.
     *
     * @return true if players + 1 nobles are dealt
     */
    protected boolean dealsNobles() {
        return true;
    }

    /**
     * Source of randomness used for shuffling (null when unseeded).
     *
     * @return random source or null
     */
    protected Random getShuffleRandom() {
        return shuffleRandom;
    }

    @Override
    public void setShuffleRandom(Random random) {
        this.shuffleRandom = random;
    }

    /**
     * Initialize state of the board (cards, nobles, tokens).
     */
    public void initBoard() {
        tier1Deck.shuffle(shuffleRandom);
        tier2Deck.shuffle(shuffleRandom);
        tier3Deck.shuffle(shuffleRandom);
        tier1OrientDeck.shuffle(shuffleRandom);
        tier2OrientDeck.shuffle(shuffleRandom);
        tier3OrientDeck.shuffle(shuffleRandom);

        tier1Deck.drawCards(4);
        tier2Deck.drawCards(4);
        tier3Deck.drawCards(4);
        tier1OrientDeck.drawCards(2);
        tier2OrientDeck.drawCards(2);
        tier3OrientDeck.drawCards(2);

        nobleDeck.shuffle(shuffleRandom);
        if (dealsNobles()) {
            nobleDeck.drawCards(players.size() + 1);
        }

        // Now initialize tokens
        int numTokens;

        switch (players.size()) {
            case 2 -> numTokens = 4;
            case 3 -> numTokens = 5;
            case 4 -> numTokens = 7;
            default -> {
                numTokens = 0;
                //logger.error("Invalid number of players."); // Testing
            }
        }

        for (TokenType tokenType : TokenType.values()) {
            tokens.put(tokenType, numTokens);
        }

        tokens.put(Satchel, 0);
        tokens.put(Gold, 5);
    }

    /**
     * Retrieve a card from the decks within the board.
     *
     * @param id card id
     * @return card from the board (could be null, if doesn't exist)
     */
    public Card getCardFromId(String id) {
        // look through all the decks
        List<Deck<? extends Card>> decks = List.of(tier1Deck, tier2Deck, tier3Deck,
                tier1OrientDeck, tier2OrientDeck, tier3OrientDeck, nobleDeck);
        Card card = null;
        for (Deck<? extends Card> deck : decks) {
            for (Card c : deck.getVisibleCards()) {
                if (c.getId().equals(id)) {
                    card = c;
                }
            }
        }
        return card;
    }

    /**
     * Take a card from whichever deck it resides in.
     *
     * @param card card to take from the board
     * @return card taken successfully
     */
    public boolean takeCard(Card card) {

        Card takenCard = null;

        if (card instanceof RegDevelopmentCard rdcard) {
            takenCard = this.tier1Deck.take(rdcard);

            if (takenCard == null) {
                takenCard = this.tier2Deck.take(rdcard);
            }

            if (takenCard == null) {
                takenCard = this.tier3Deck.take(rdcard);
            }

        } else if (card instanceof OrientDevelopmentCard ordcard) {
            takenCard = this.tier1OrientDeck.take(ordcard);

            if (takenCard == null) {
                takenCard = this.tier2OrientDeck.take(ordcard);
            }

            if (takenCard == null) {
                takenCard = this.tier3OrientDeck.take(ordcard);
            }

        } else if (card instanceof NobleCard nbcard) {
            takenCard = this.nobleDeck.take(nbcard);
        }

        return takenCard != null;
    }

    /**
     * Check if player has the right bonuses to qualify for any nobles.
     *
     * @param player Player to check
     * @return List of nobles player qualifies for
     */
    public ArrayList<NobleCard> qualifiesForNoble(Player player) {
        ArrayList<NobleCard> noblesQualifiedFor = new ArrayList<>();

        ArrayList<NobleCard> nobles = new ArrayList<>(nobleDeck.getVisibleCards());
        nobles.addAll(player.getReservedNobles());

        for (NobleCard noble : nobles) {
            int notEnoughBonusesCounter = 0;

            for (TokenType tokenType : noble.getTokenCost().keySet()) {
                // subtract player's bonuses of this TokenType from noble card cost
                int bonusRemaining = noble.getTokenCost().get(tokenType) - player.getBonuses().get(tokenType);
                if (bonusRemaining > 0) {
                    notEnoughBonusesCounter++;
                }
            }

            if (notEnoughBonusesCounter == 0) {
                noblesQualifiedFor.add(noble);
            }
        }

        return noblesQualifiedFor;
    }

    /**
     * Give a noble to a player: from the board, or from the player's reserved nobles.
     * Counts as this turn's noble visit.
     *
     * @param player player receiving the noble
     * @param noble noble being given
     */
    public void grantNoble(Player player, NobleCard noble) {
        if (player.getReservedNobles().contains(noble)) {
            player.removeReservedNoble(noble);
        } else {
            takeCard(noble);
        }
        player.addNoble(noble);
        nobleVisitedThisTurn = true;
    }

    /**
     * Whether a player owns a development card with a gem bonus (needed before a Satchel card can be taken).
     *
     * @param player player to check
     * @return true if the player owns a card whose bonus is a gem colour
     */
    public static boolean ownsGemBonusCard(Player player) {
        for (DevelopmentCard c : player.getDevCards()) {
            if (c.getTokenType() != null && c.getTokenType().isGem()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Cards a player may take for free with a cascade of the given tier: the visible cards of that tier,
     * from the regular and the Orient rows, except Satchel cards when the player has no gem bonus card yet.
     *
     * @param player player cascading
     * @param tier tier of card to take
     * @return cards that may be chosen
     */
    public List<DevelopmentCard> getCascadeChoices(Player player, CardTier tier) {
        List<DevelopmentCard> choices = new ArrayList<>();
        switch (tier) {
            case TIER_1 -> {
                choices.addAll(tier1Deck.getVisibleCards());
                choices.addAll(tier1OrientDeck.getVisibleCards());
            }
            case TIER_2 -> {
                choices.addAll(tier2Deck.getVisibleCards());
                choices.addAll(tier2OrientDeck.getVisibleCards());
            }
            default -> {
                // no cascade takes a tier 3 card
            }
        }
        if (!ownsGemBonusCard(player)) {
            choices.removeIf(c -> c.getTokenType() == Satchel);
        }
        return choices;
    }

    /**
     * Follow-up actions caused by acquiring a development card (by buying it or through a cascade).
     * A follow-up is only requested when it can actually be carried out, so that no turn gets stuck.
     *
     * @param player player acquiring the card
     * @param card card acquired
     * @return MUST_* results describing the follow-ups
     */
    public List<ActionResult> followUpsForAcquiredCard(Player player, DevelopmentCard card) {
        List<ActionResult> followUps = new ArrayList<>();
        if (!(card instanceof OrientDevelopmentCard orientCard)) {
            return followUps;
        }
        if (orientCard.getReserveNoble() && !getNobles().isEmpty()) {
            followUps.add(ActionResult.MUST_RESERVE_NOBLE);
        }
        if (orientCard.getCascadeType() == CascadeType.Tier1 && !getCascadeChoices(player, CardTier.TIER_1).isEmpty()) {
            followUps.add(ActionResult.MUST_CHOOSE_CASCADE_CARD_TIER_1);
        } else if (orientCard.getCascadeType() == CascadeType.Tier2
                && !getCascadeChoices(player, CardTier.TIER_2).isEmpty()) {
            followUps.add(ActionResult.MUST_CHOOSE_CASCADE_CARD_TIER_2);
        }
        if (orientCard.getTokenType() == Satchel) {
            followUps.add(ActionResult.MUST_CHOOSE_TOKEN_TYPE);
        }
        return followUps;
    }

    /**
     * Whether a player still has a Satchel card whose colour has not been chosen.
     *
     * @param player player to check
     * @return true if a Satchel colour is still to be chosen
     */
    public static boolean hasUnassignedSatchel(Player player) {
        for (DevelopmentCard c : player.getDevCards()) {
            if (c.getTokenType() == Satchel) {
                return true;
            }
        }
        return false;
    }

    /**
     * Allows player to perform an action.
     *
     * @param playerName player performing action
     * @param action     action being executed
     * @return result of action execution
     */
    @Override
    public ArrayList<ActionResult> takeAction(String playerName, Action action) {

        ArrayList<ActionResult> results = new ArrayList<>();

        if (gameOver) {
            results.add(ActionResult.GAME_OVER);
            return results;
        }

        Player p = this.getPlayerFromName(playerName);
        if (p == null || players.indexOf(p) != this.turnCounter) {
            results.add(ActionResult.INVALID_PLAYER);
            return results;
        }

        if (action == null || !curValidActions.contains(action.getActionType())) {
            results.add(ActionResult.ACTION_NOT_ALLOWED);
            return results;
        }

        results.addAll(action.execute(this, p));
        if (!results.contains(ActionResult.VALID_ACTION)) {
            // rejected: actions check everything before changing state, so nothing changed
            return results;
        }

        for (ActionResult result : results) {
            Actions followUp = followUpFor(result);
            if (followUp != null) {
                addValidAction(followUp);
            }
        }
        removeImpossibleFollowUps(p);

        if (curValidActions.isEmpty()) {
            endOfTurnChecks(p, results);
        }

        if (curValidActions.isEmpty()) {
            finishTurn();
        }

        return results;
    }

    private static Actions followUpFor(ActionResult result) {
        return switch (result) {
            case MUST_CHOOSE_CASCADE_CARD_TIER_1 -> Actions.CASCADE_1;
            case MUST_CHOOSE_CASCADE_CARD_TIER_2 -> Actions.CASCADE_2;
            case MUST_CHOOSE_TOKEN_TYPE -> Actions.CHOOSE_SATCHEL_TOKEN;
            case MUST_RESERVE_NOBLE -> Actions.RESERVE_NOBLE;
            case MUST_TAKE_EXTRA_TOKEN_AFTER_PURCHASE -> Actions.TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER;
            default -> null;
        };
    }

    /**
     * Safety net against stuck turns: drop follow-ups that can no longer be carried out.
     *
     * @param player current player
     */
    protected void removeImpossibleFollowUps(Player player) {
        if (curValidActions.contains(Actions.RESERVE_NOBLE) && getNobles().isEmpty()) {
            curValidActions.remove(Actions.RESERVE_NOBLE);
        }
        if (curValidActions.contains(Actions.CASCADE_1) && getCascadeChoices(player, CardTier.TIER_1).isEmpty()) {
            curValidActions.remove(Actions.CASCADE_1);
        }
        if (curValidActions.contains(Actions.CASCADE_2) && getCascadeChoices(player, CardTier.TIER_2).isEmpty()) {
            curValidActions.remove(Actions.CASCADE_2);
        }
        if (curValidActions.contains(Actions.CHOOSE_SATCHEL_TOKEN)
                && (!hasUnassignedSatchel(player) || !ownsGemBonusCard(player))) {
            curValidActions.remove(Actions.CHOOSE_SATCHEL_TOKEN);
        }
        if (curValidActions.contains(Actions.CHOOSE_NOBLE) && qualifiesForNoble(player).isEmpty()) {
            curValidActions.remove(Actions.CHOOSE_NOBLE);
        }
    }

    /**
     * Checks run once the current player has no follow-up action left: at most one noble visit per turn,
     * then expansion specific checks, then recording the player as a potential winner.
     * May add a choice (CHOOSE_NOBLE, CHOOSE_CITY) that the player has to make before the turn ends.
     *
     * @param player current player
     * @param results results of the action, MUST_* results for new choices are appended
     */
    protected void endOfTurnChecks(Player player, List<ActionResult> results) {
        if (!nobleVisitedThisTurn) {
            List<NobleCard> nobles = qualifiesForNoble(player);
            if (nobles.size() == 1) {
                grantNoble(player, nobles.get(0));
            } else if (nobles.size() > 1) {
                addValidAction(Actions.CHOOSE_NOBLE);
                results.add(ActionResult.MUST_CHOOSE_NOBLE);
                return;
            }
        }

        expansionEndOfTurnChecks(player, results);

        if (curValidActions.isEmpty() && canPlayerWin(player) && !playersWhoCanWin.contains(player)) {
            addPlayersWhoCanWin(player);
        }
    }

    /**
     * Expansion specific end of turn checks (Trading Posts powers, Cities). Runs after the noble visit.
     *
     * @param player current player
     * @param results results of the action, MUST_* results for new choices are appended
     */
    protected void expansionEndOfTurnChecks(Player player, List<ActionResult> results) {
        // nothing for the base game + Orient
    }

    /**
     * End the current player's turn: end the game if the round is over and someone reached the target,
     * otherwise pass the turn to the next player.
     */
    private void finishTurn() {
        List<Player> roundWinners = checkForWin();
        if (roundWinners != null) {
            winners = new ArrayList<>(roundWinners);
            gameOver = true;
            turnCounter = GAME_OVER_TURN_COUNTER;
            curValidActions.clear();
        } else {
            this.incrementTurn();
        }
    }

    /**
     * Whether the current player is the last one in the round (so all players have had the same number of turns
     * once they finish).
     *
     * @return true if the current seat is the last seat
     */
    public boolean isLastTurnOfRound() {
        return turnCounter == players.size() - 1;
    }

    /**
     * Pick the winners among players who reached the end condition: the most prestige points win, ties are broken
     * by the fewest development cards, and players still tied share the victory.
     *
     * @param candidates players who reached the end condition
     * @return winners, in seat order
     */
    protected List<Player> determineWinners(List<Player> candidates) {
        int mostPoints = candidates.stream().mapToInt(Player::getPrestigePoints).max().orElse(0);
        int fewestCards = candidates.stream().filter(p -> p.getPrestigePoints() == mostPoints)
                .mapToInt(p -> p.getDevCards().size()).min().orElse(0);
        List<Player> result = new ArrayList<>();
        for (Player p : candidates) {
            if (p.getPrestigePoints() == mostPoints && p.getDevCards().size() == fewestCards) {
                result.add(p);
            }
        }
        result.sort(Comparator.comparingInt(players::indexOf));
        return result;
    }

    /**
     * Get the list of nobles on the game board.
     *
     * @return list of nobles visible
     */
    public List<NobleCard> getNobles() {
        return new ArrayList<>(this.nobleDeck.getVisibleCards());
    }

    /**
     * Get the list of players who can win this round.
     *
     * @return list of players who can win
     */
    public List<Player> getPlayersWhoCanWin() {
        return new ArrayList<>(playersWhoCanWin);
    }

    @Override
    public List<RegDevelopmentCard> getTier1PurchasableDevelopmentCards() {
        return this.tier1Deck.getVisibleCards();
    }

    @Override
    public List<RegDevelopmentCard> getTier2PurchasableDevelopmentCards() {
        return this.tier2Deck.getVisibleCards();
    }

    @Override
    public List<RegDevelopmentCard> getTier3PurchasableDevelopmentCards() {
        return this.tier3Deck.getVisibleCards();
    }

    @Override
    public List<OrientDevelopmentCard> getTier1PurchasableOrientCards() {
        return this.tier1OrientDeck.getVisibleCards();
    }

    @Override
    public List<OrientDevelopmentCard> getTier2PurchasableOrientCards() {
        return this.tier2OrientDeck.getVisibleCards();
    }

    /**
     * Get the current two visible tier 3 orient cards.
     *
     * @return list of visible tier 3 orient cards
     */
    public List<OrientDevelopmentCard> getTier3PurchasableOrientCards() {
        return this.tier3OrientDeck.getVisibleCards();
    }

    /**
     * All development card decks of the board (regular tiers 1 to 3, then Orient tiers 1 to 3).
     *
     * @return the six development card decks
     */
    public List<Deck<? extends DevelopmentCard>> getDevelopmentDecks() {
        return List.of(tier1Deck, tier2Deck, tier3Deck, tier1OrientDeck, tier2OrientDeck, tier3OrientDeck);
    }

    /**
     * The noble deck of the board.
     *
     * @return noble deck
     */
    public Deck<NobleCard> getNobleDeck() {
        return nobleDeck;
    }

    @Override
    public Player createPlayer(String name, String colour) {
        return new OrientPlayer(name, colour);
    }

    @Override
    public void addTokens(Map<TokenType, Integer> tokensInput) {
        for (Map.Entry<TokenType, Integer> entry : tokensInput.entrySet()) {
            TokenType tokenType = entry.getKey();
            int amount = entry.getValue();

            if (this.tokens.containsKey(tokenType) && amount > 0) {
                this.tokens.put(tokenType, this.tokens.get(tokenType) + amount);
            }
        }
    }

    @Override
    public boolean removeTokens(Map<TokenType, Integer> tokensToRemove) {
        // check everything first, so that a failed removal changes nothing
        for (Map.Entry<TokenType, Integer> entry : tokensToRemove.entrySet()) {
            int available = tokens.getOrDefault(entry.getKey(), 0);
            if (entry.getValue() < 0 || available - entry.getValue() < 0) {
                return false;
            }
        }
        for (Map.Entry<TokenType, Integer> entry : tokensToRemove.entrySet()) {
            this.tokens.put(entry.getKey(), tokens.getOrDefault(entry.getKey(), 0) - entry.getValue());
        }
        return true;
    }

    @Override
    public HashMap<TokenType, Integer> getTokens() {
        return new HashMap<>(this.tokens);
    }


    @Override
    public Player incrementTurn() {
        if (turnCounter == this.players.size() - 1) {
            turnCounter = 0;
        } else {
            turnCounter++;
        }

        // reset list of current player valid actions
        curValidActions.clear();
        curValidActions.add(Actions.BUY_CARD);
        curValidActions.add(Actions.TAKE_TOKEN);
        curValidActions.add(Actions.RESERVE_CARD);
        nobleVisitedThisTurn = false;

        return players.get(turnCounter);
    }

    @Override
    public Player getTurnCurrentPlayer() {
        if (gameOver || turnCounter < 0 || turnCounter >= players.size()) {
            return null;
        }
        return players.get(turnCounter);
    }

    @Override
    public int getTurnCounter() {
        return turnCounter;
    }

    @Override
    public Player getPlayerFromName(String name) {
        Player player = null;

        for (Player p : this.players) {
            if (p.getName().equals(name)) {
                player = p;
                break;
            }
        }

        return player;
    }

    @Override
    public void setPlayers(List<Player> players) {
        this.players.addAll(players);
    }

    @Override
    public List<Player> getPlayers() {
        return new ArrayList<>(players);
    }

    @Override
    public List<Actions> getCurValidActions() {
        return new ArrayList<>(curValidActions);
    }

    @Override
    public GameVersions getGameVersion() {
        return this.gameVersion;
    }

    /**
     * Number of prestige points needed to end the game (not used by the Cities versions).
     *
     * @return target prestige points
     */
    public int getPrestigePointsToWin() {
        return prestigePointsToWin;
    }

    @Override
    public void addValidAction(Actions action) {
        // each kind of follow-up is listed once: listing it twice could leave a turn stuck
        if (!curValidActions.contains(action)) {
            curValidActions.add(action);
        }
    }

    @Override
    public void removeValidAction(Actions action) {
        curValidActions.remove(action);
    }

    @Override
    public void clearValidActions() {
        curValidActions.clear();
    }

    @Override
    public void clearMainValidActions() {
        curValidActions.remove(Actions.BUY_CARD);
        curValidActions.remove(Actions.TAKE_TOKEN);
        curValidActions.remove(Actions.RESERVE_CARD);
    }

    /**
     * Winners if the game ends now: only at the end of a round (the last seat just finished its turn), and only if
     * at least one player reached the end condition. Does not change the game state.
     *
     * @return winners, or null if the game goes on
     */
    @Override
    public List<Player> checkForWin() {
        if (!isLastTurnOfRound()) {
            return null;
        }
        List<Player> candidates = new ArrayList<>();
        for (Player p : players) {
            if (canPlayerWin(p)) {
                candidates.add(p);
            }
        }
        if (candidates.isEmpty()) {
            return null;
        }
        return determineWinners(candidates);
    }

    @Override
    public boolean canPlayerWin(Player player) {
        return (player.getPrestigePoints() >= prestigePointsToWin);
    }

    @Override
    public void addPlayersWhoCanWin(Player player) {
        playersWhoCanWin.add(player);
    }

    @Override
    public List<Player> getWinner() {
        return winners;
    }

    @Override
    public boolean isGameOver() {
        return gameOver;
    }

    @Override
    public void setGameOver(boolean gameOver) {
        this.gameOver = gameOver;
    }

}
