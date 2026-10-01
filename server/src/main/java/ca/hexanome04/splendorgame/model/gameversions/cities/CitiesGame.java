package ca.hexanome04.splendorgame.model.gameversions.cities;

import static ca.hexanome04.splendorgame.model.TokenType.*;

import ca.hexanome04.splendorgame.model.*;
import ca.hexanome04.splendorgame.model.action.ActionResult;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.gameversions.GameVersions;
import ca.hexanome04.splendorgame.model.gameversions.orient.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;


/**
 * Class that represents the current state of an orient + cities game.
 */
public class CitiesGame extends OrientGame {

    private static final String cityCardsFilename = "classpath:citycards.csv";

    private Deck<CityCard> citiesDeck;
    static final Logger logger = LoggerFactory.getLogger(CitiesGame.class);

    /** City card file to load (null means the default classpath resource); never saved or sent to clients. */
    private transient String cityCardsResource;

    /**
     * Creates a Splendor Cities game played without nobles (the official Cities rule).
     *
     * @param turnCounter The turn id associated with the player.
     */
    public CitiesGame(int turnCounter) {
        this(GameVersions.BASE_ORIENT_CITIES, turnCounter);
    }

    /**
     * Creates a Splendor Cities game.
     *
     * @param gameVersion BASE_ORIENT_CITIES (no nobles) or BASE_ORIENT_CITIES_NOBLES (nobles dealt as usual)
     * @param turnCounter The turn id associated with the player.
     */
    public CitiesGame(GameVersions gameVersion, int turnCounter) {
        super(gameVersion, -1, turnCounter);
        if (gameVersion != GameVersions.BASE_ORIENT_CITIES && gameVersion != GameVersions.BASE_ORIENT_CITIES_NOBLES) {
            throw new IllegalArgumentException("Not a Cities game version: " + gameVersion);
        }
    }

    /**
     * Use a specific city card file instead of the default {@code classpath:citycards.csv} (for tests and tools).
     * Must be called before {@link #createSplendorBoard()}.
     *
     * @param resource Spring resource location
     */
    public void setCityCardsResource(String resource) {
        this.cityCardsResource = resource;
    }

    /**
     * Nobles are only dealt in the BASE_ORIENT_CITIES_NOBLES variant.
     *
     * @return true if nobles are dealt
     */
    @Override
    protected boolean dealsNobles() {
        return getGameVersion() == GameVersions.BASE_ORIENT_CITIES_NOBLES;
    }

    /**
     * Constructor for the cities splendorBoard, initializes the city deck with cards from a file.
     */
    @Override
    public void createSplendorBoard() {
        super.createSplendorBoard();

        citiesDeck = new Deck<>();
        String resource = cityCardsResource == null ? cityCardsFilename : cityCardsResource;
        TokenType[] types = {White, Blue, Green, Red, Brown};

        for (String[] card : readCardFile(resource)) {
            try {
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
                int numSameBonuses = Integer.parseInt(cost[5]);

                int prestigePoints = Integer.parseInt(card[2]);
                String cardId = card[6];

                if (!"C".equals(card[5])) {
                    throw new IllegalArgumentException("Unknown city row type '" + card[5] + "'");
                }
                citiesDeck.add(new CityCard(prestigePoints, tokenCost, cardId, numSameBonuses));
            } catch (RuntimeException e) {
                logger.error("Malformed city line in {}: {}", resource, String.join(",", card), e);
                throw new IllegalStateException("Malformed city line in " + resource + ": " + String.join(",", card), e);
            }
        }
    }

    /**
     * Initialize cities-specific state of board.
     */
    @Override
    public void initBoard() {
        super.initBoard();

        citiesDeck.shuffle(getShuffleRandom());
        citiesDeck.drawCards(3);

    }

    /**
     * Retrieve a card from the decks within the board.
     *
     * @param id card id
     * @return card from the board (could be null, if doesn't exist)
     */
    @Override
    public Card getCardFromId(String id) {
        Card card = super.getCardFromId(id);

        for (Card c : this.citiesDeck.getVisibleCards()) {
            if (c.getId().equals(id)) {
                card = c;
            }
        }

        return card;
    }

    /**
     * The city deck of the board.
     *
     * @return city deck
     */
    public Deck<CityCard> getCitiesDeck() {
        return citiesDeck;
    }

    /**
     * Check if player has the right bonuses to qualify for any cities.
     * Also records the cities in the player's list of cities qualified for (shown by the client).
     *
     * @param player Player to check
     * @return List of cities player qualifies for
     */
    public ArrayList<CityCard> qualifiesCities(Player player) {
        ArrayList<CityCard> cities = new ArrayList<>(citiesDeck.getVisibleCards());
        CitiesPlayer p = ((CitiesPlayer) player);

        ArrayList<CityCard> qualifyCities = new ArrayList<>();
        for (CityCard city : cities) {

            boolean qualifiesForCity = true;

            // check for same bonus requirement: that many bonuses of one gem colour (gold does not count)
            // that is not already part of the city's colour requirements
            int maxSameNumBonuses = 0;
            for (Map.Entry<TokenType, Integer> entry : player.getBonuses().entrySet()) {
                TokenType color = entry.getKey();
                if (color.isGem() && entry.getValue() > maxSameNumBonuses && city.getTokenCost().get(color) == 0) {
                    maxSameNumBonuses = entry.getValue();
                }
            }
            if (maxSameNumBonuses < city.getNumSameBonuses()) {
                qualifiesForCity = false;
            }

            // check for normal bonus requirements
            for (Map.Entry<TokenType, Integer> entry : city.getTokenCost().entrySet()) {
                TokenType color = entry.getKey();
                if (player.getBonuses().get(color) < entry.getValue()) {
                    qualifiesForCity = false;
                }
            }

            // check for prestige point requirement
            if (player.getPrestigePoints() < city.getPrestigePoints()) {
                qualifiesForCity = false;
            }

            // if nothing disqualifies city, return true
            if (qualifiesForCity) {
                qualifyCities.add(city);
                if (!p.getCitiesQualifiedFor().contains(city)) {
                    p.addCityQualifiedFor(city);
                }
            }
        }
        return qualifyCities;
    }

    /**
     * At the end of a turn a player without a city takes the city they qualify for, or chooses one if they
     * qualify for several. Taking a city ends the game at the end of the round.
     *
     * @param player current player
     * @param results results of the action, MUST_CHOOSE_CITY is appended when a choice is needed
     */
    @Override
    protected void expansionEndOfTurnChecks(Player player, List<ActionResult> results) {
        CitiesPlayer cp = (CitiesPlayer) player;
        if (!cp.getCities().isEmpty()) {
            return;
        }
        ArrayList<CityCard> citiesQualifiedFor = qualifiesCities(cp);
        if (citiesQualifiedFor.size() == 1) {
            takeCard(citiesQualifiedFor.get(0));
            cp.addCity(citiesQualifiedFor.get(0));
        } else if (citiesQualifiedFor.size() > 1) {
            this.addValidAction(Actions.CHOOSE_CITY);
            results.add(ActionResult.MUST_CHOOSE_CITY);
        }
    }

    @Override
    protected void removeImpossibleFollowUps(Player player) {
        super.removeImpossibleFollowUps(player);
        if (getCurValidActions().contains(Actions.CHOOSE_CITY) && qualifiesCities(player).isEmpty()) {
            removeValidAction(Actions.CHOOSE_CITY);
        }
    }

    /**
     * A Cities game ends at the end of the round in which a player took a city.
     *
     * @param player player to check
     * @return true if the player owns a city
     */
    @Override
    public boolean canPlayerWin(Player player) {
        CitiesPlayer p = (CitiesPlayer) player;
        return !p.getCities().isEmpty();
    }

    @Override
    public boolean takeCard(Card card) {
        if (card instanceof CityCard cityCard) {
            return (this.citiesDeck.take(cityCard)) != null;
        } else {
            return super.takeCard(card);
        }
    }

    /**
     * Creates a cities player.
     *
     * @param name name of the player
     * @param colour color of the player
     * @return player created
     */
    @Override
    public Player createPlayer(String name, String colour) {
        return new CitiesPlayer(name, colour);
    }
}
