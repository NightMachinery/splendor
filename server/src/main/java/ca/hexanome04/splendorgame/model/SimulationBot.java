package ca.hexanome04.splendorgame.model;

import ca.hexanome04.splendorgame.model.action.Action;
import ca.hexanome04.splendorgame.model.action.Actions;
import ca.hexanome04.splendorgame.model.action.actions.BuyCardAction;
import ca.hexanome04.splendorgame.model.action.actions.CascadeTier1Action;
import ca.hexanome04.splendorgame.model.action.actions.CascadeTier2Action;
import ca.hexanome04.splendorgame.model.action.actions.ChooseCityAction;
import ca.hexanome04.splendorgame.model.action.actions.ChooseNobleAction;
import ca.hexanome04.splendorgame.model.action.actions.ChooseTokenTypeAction;
import ca.hexanome04.splendorgame.model.action.actions.ReserveCardAction;
import ca.hexanome04.splendorgame.model.action.actions.ReserveNobleAction;
import ca.hexanome04.splendorgame.model.action.actions.TakeExtraTokenAfterPurchasePowerAction;
import ca.hexanome04.splendorgame.model.action.actions.TakeTokenAction;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.cities.CityCard;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Bot policy shared by practice games and simulation tests. It chooses actions from the visible
 * game state and the current player's available actions.
 *
 * <p>Strategy: answer pending follow-ups first; otherwise buy the most valuable card it can pay for exactly,
 * sometimes reserve, otherwise take tokens towards the card closest to affordable (returning tokens to stay at
 * 10), and pass only when nothing else is possible.</p>
 */
public class SimulationBot {

    /** The five gem colours. */
    public static final List<TokenType> GEMS = List.of(TokenType.White, TokenType.Blue, TokenType.Green,
            TokenType.Red, TokenType.Brown);

    private final Random random;

    /** What kind of move the last chosen action was, for usage statistics. */
    private String lastKind = "";

    /**
     * Create a bot.
     *
     * @param random source of randomness for tie breaks (seeded for reproducible games)
     */
    public SimulationBot(Random random) {
        this.random = random;
    }

    private static int amount(Map<TokenType, Integer> map, TokenType type) {
        Integer value = map.get(type);
        return value == null ? 0 : value;
    }

    private static int total(Map<TokenType, Integer> map) {
        int sum = 0;
        for (Integer v : map.values()) {
            sum += v == null ? 0 : v;
        }
        return sum;
    }

    /**
     * Whether the player owns a card with a gem bonus (needed before taking a Satchel card).
     *
     * @param p player
     * @return true if a gem bonus card is owned
     */
    public static boolean ownsGemCard(Player p) {
        for (DevelopmentCard c : p.getDevCards()) {
            if (c.getTokenType() != null && GEMS.contains(c.getTokenType())) {
                return true;
            }
        }
        return false;
    }

    /**
     * Visible development cards of one tier, regular row then Orient row.
     *
     * @param game game
     * @param tier tier
     * @return visible cards of that tier
     */
    public static List<DevelopmentCard> visibleOfTier(OrientGame game, CardTier tier) {
        List<DevelopmentCard> cards = new ArrayList<>();
        switch (tier) {
            case TIER_1 -> {
                cards.addAll(game.getTier1PurchasableDevelopmentCards());
                cards.addAll(game.getTier1PurchasableOrientCards());
            }
            case TIER_2 -> {
                cards.addAll(game.getTier2PurchasableDevelopmentCards());
                cards.addAll(game.getTier2PurchasableOrientCards());
            }
            case TIER_3 -> {
                cards.addAll(game.getTier3PurchasableDevelopmentCards());
                cards.addAll(game.getTier3PurchasableOrientCards());
            }
            default -> throw new IllegalArgumentException(String.valueOf(tier));
        }
        return cards;
    }

    /**
     * All visible development cards.
     *
     * @param game game
     * @return visible cards of every tier
     */
    public static List<DevelopmentCard> allVisible(OrientGame game) {
        List<DevelopmentCard> cards = new ArrayList<>();
        for (CardTier tier : CardTier.values()) {
            cards.addAll(visibleOfTier(game, tier));
        }
        return cards;
    }

    /**
     * Cards a cascade of the given tier may take, computed from the board.
     *
     * @param game game
     * @param p player
     * @param tier tier of the cascade
     * @return cards that may be taken
     */
    public static List<DevelopmentCard> cascadeChoices(OrientGame game, Player p, CardTier tier) {
        List<DevelopmentCard> cards = visibleOfTier(game, tier);
        if (!ownsGemCard(p)) {
            cards.removeIf(c -> c.getTokenType() == TokenType.Satchel);
        }
        return cards;
    }

    /**
     * The exact payment for a card, or null if the player cannot afford it.
     * Gem tokens are used first, then gold tokens, then gold bonuses (double gold cards).
     *
     * @param p player
     * @param card card
     * @return payment, or null
     */
    public static HashMap<TokenType, Integer> exactPayment(Player p, DevelopmentCard card) {
        if (card.getTokenType() == TokenType.Satchel && !ownsGemCard(p)) {
            return null;
        }
        Map<TokenType, Integer> cost = card.getTokenCost();
        Map<TokenType, Integer> bonuses = p.getBonuses();
        Map<TokenType, Integer> held = p.getTokens();
        HashMap<TokenType, Integer> pay = new HashMap<>();
        if (card.getCostType() == CostType.Bonus) {
            for (TokenType t : GEMS) {
                if (amount(cost, t) > amount(bonuses, t)) {
                    return null;
                }
            }
            return pay;
        }
        int goldValue = p instanceof TradingPostsPlayer tpp && tpp.goldTokenWorthTwoTokens.isUnlocked() ? 2 : 1;
        int goldNeeded = 0;
        for (TokenType t : GEMS) {
            int owed = Math.max(0, amount(cost, t) - amount(bonuses, t));
            int use = Math.min(owed, amount(held, t));
            if (use > 0) {
                pay.put(t, use);
            }
            int deficit = owed - use;
            goldNeeded += (deficit + goldValue - 1) / goldValue;
        }
        int goldTokens = Math.min(goldNeeded, amount(held, TokenType.Gold));
        if (goldTokens > 0) {
            pay.put(TokenType.Gold, goldTokens);
        }
        if (goldNeeded - goldTokens > amount(bonuses, TokenType.Gold)) {
            return null;
        }
        return pay;
    }

    /**
     * Gems still missing for a card after bonuses and held tokens (gold not counted).
     *
     * @param p player
     * @param card card
     * @return missing gems per colour
     */
    private static Map<TokenType, Integer> missing(Player p, DevelopmentCard card) {
        Map<TokenType, Integer> result = new HashMap<>();
        if (card.getCostType() == CostType.Bonus) {
            return result;
        }
        for (TokenType t : GEMS) {
            int m = amount(card.getTokenCost(), t) - amount(p.getBonuses(), t) - amount(p.getTokens(), t);
            if (m > 0) {
                result.put(t, m);
            }
        }
        return result;
    }

    private <T> T pick(List<T> options) {
        return options.get(random.nextInt(options.size()));
    }

    /**
     * What kind of move the last chosen action was (such as "buy", "take with put-back" or "CASCADE_1").
     *
     * @return kind of the last move
     */
    public String getLastKind() {
        return lastKind;
    }

    /**
     * Choose the next action for the current player.
     *
     * @param game game (not over)
     * @param p current player
     * @return a legal action
     */
    public Action chooseAction(OrientGame game, Player p) {
        List<Actions> valid = game.getCurValidActions();
        if (valid.isEmpty()) {
            throw new IllegalStateException("No valid action for " + p.getName());
        }
        if (!valid.contains(Actions.BUY_CARD)) {
            lastKind = valid.get(0).toString();
            return followUp(game, p, valid.get(0));
        }
        return mainAction(game, p);
    }

    private Action followUp(OrientGame game, Player p, Actions pending) {
        switch (pending) {
            case CASCADE_1, CASCADE_2 -> {
                CardTier tier = pending == Actions.CASCADE_1 ? CardTier.TIER_1 : CardTier.TIER_2;
                List<DevelopmentCard> choices = cascadeChoices(game, p, tier);
                if (choices.isEmpty()) {
                    throw new IllegalStateException(pending + " is pending but there is no card to take");
                }
                choices.sort(Comparator.comparingInt(DevelopmentCard::getPrestigePoints).reversed());
                String id = choices.get(0).getId();
                return pending == Actions.CASCADE_1 ? new CascadeTier1Action(id) : new CascadeTier2Action(id);
            }
            case CHOOSE_SATCHEL_TOKEN -> {
                DevelopmentCard satchel = null;
                for (DevelopmentCard c : p.getDevCards()) {
                    if (c.getTokenType() == TokenType.Satchel) {
                        satchel = c;
                        break;
                    }
                }
                List<TokenType> owned = new ArrayList<>();
                for (DevelopmentCard c : p.getDevCards()) {
                    if (c.getTokenType() != null && GEMS.contains(c.getTokenType())
                            && !owned.contains(c.getTokenType())) {
                        owned.add(c.getTokenType());
                    }
                }
                if (satchel == null || owned.isEmpty()) {
                    throw new IllegalStateException("CHOOSE_SATCHEL_TOKEN is pending but cannot be done");
                }
                return new ChooseTokenTypeAction(satchel.getId(), pick(owned));
            }
            case RESERVE_NOBLE -> {
                List<NobleCard> nobles = game.getNobles();
                if (nobles.isEmpty()) {
                    throw new IllegalStateException("RESERVE_NOBLE is pending but no noble is on the board");
                }
                return new ReserveNobleAction(pick(nobles).getId());
            }
            case CHOOSE_NOBLE -> {
                List<NobleCard> options = new ArrayList<>(game.getNobles());
                options.addAll(p.getReservedNobles());
                options.removeIf(n -> !qualifies(p, n));
                if (options.size() < 2) {
                    throw new IllegalStateException("CHOOSE_NOBLE is pending with " + options.size() + " options");
                }
                return new ChooseNobleAction(pick(options).getId());
            }
            case CHOOSE_CITY -> {
                List<CityCard> cities = ((CitiesGame) game).qualifiesCities(p);
                if (cities.size() < 2) {
                    throw new IllegalStateException("CHOOSE_CITY is pending with " + cities.size() + " options");
                }
                return new ChooseCityAction(pick(cities).getId());
            }
            case TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER -> {
                List<TokenType> available = new ArrayList<>();
                for (TokenType t : GEMS) {
                    if (amount(game.getTokens(), t) > 0) {
                        available.add(t);
                    }
                }
                if (available.isEmpty() || random.nextInt(5) == 0) {
                    lastKind = "TAKE_EXTRA_TOKEN (skipped)";
                    return new TakeExtraTokenAfterPurchasePowerAction(null, null);
                }
                TokenType take = pick(available);
                TokenType putBack = null;
                if (total(p.getTokens()) >= 10) {
                    List<TokenType> held = new ArrayList<>();
                    held.add(take);
                    for (TokenType t : GEMS) {
                        if (amount(p.getTokens(), t) > 0) {
                            held.add(t);
                        }
                    }
                    putBack = pick(held);
                    lastKind = "TAKE_EXTRA_TOKEN (with put-back)";
                }
                return new TakeExtraTokenAfterPurchasePowerAction(take, putBack);
            }
            default -> throw new IllegalStateException("Unexpected pending action " + pending);
        }
    }

    private static boolean qualifies(Player p, NobleCard noble) {
        for (TokenType t : GEMS) {
            if (amount(noble.getTokenCost(), t) > amount(p.getBonuses(), t)) {
                return false;
            }
        }
        return true;
    }

    private Action mainAction(OrientGame game, Player p) {
        List<DevelopmentCard> candidates = new ArrayList<>(allVisible(game));
        candidates.addAll(p.getReservedCards());

        // buy the most valuable affordable card
        DevelopmentCard best = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (DevelopmentCard c : candidates) {
            if (exactPayment(p, c) == null) {
                continue;
            }
            double score = c.getPrestigePoints() * 10 + c.getBonus() * 2 + random.nextDouble();
            if (p.getReservedCards().contains(c)) {
                score += 3;
            }
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        boolean canReserve = p.getReservedCards().size() < 3 && !allVisible(game).isEmpty();
        if (best != null && random.nextInt(10) != 0) {
            return buy(p, best);
        }
        if (canReserve && random.nextInt(6) == 0) {
            return reserve(game, p);
        }
        Action take = takeTowards(game, p, candidates);
        if (take != null) {
            return take;
        }
        if (best != null) {
            return buy(p, best);
        }
        if (canReserve) {
            return reserve(game, p);
        }
        // nothing else is possible: an empty take is a pass
        lastKind = "pass";
        return new TakeTokenAction(new HashMap<>(), new HashMap<>());
    }

    private Action buy(Player p, DevelopmentCard card) {
        boolean reserved = p.getReservedCards().contains(card);
        lastKind = card.getCostType() == CostType.Bonus ? "buy (sacrifice)"
                : amount(p.getBonuses(), TokenType.Gold) > 0 ? "buy (holding gold bonus)"
                : reserved ? "buy (reserved card)" : "buy";
        return new BuyCardAction(card.getId(), exactPayment(p, card));
    }

    private Action reserve(OrientGame game, Player p) {
        List<DevelopmentCard> visible = allVisible(game);
        visible.sort(Comparator.comparingInt(DevelopmentCard::getPrestigePoints).reversed());
        DevelopmentCard card = random.nextBoolean() ? visible.get(0) : pick(visible);
        if (total(p.getTokens()) >= 10 && amount(game.getTokens(), TokenType.Gold) > 0 && random.nextBoolean()) {
            // official rule: take the gold, then return a token (possibly the gold itself)
            List<TokenType> held = new ArrayList<>();
            held.add(TokenType.Gold);
            for (TokenType t : GEMS) {
                if (amount(p.getTokens(), t) > 0) {
                    held.add(t);
                }
            }
            lastKind = "reserve (with put-back)";
            return new ReserveCardAction(card.getId(), pick(held));
        }
        lastKind = "reserve";
        return new ReserveCardAction(card.getId());
    }

    private Action takeTowards(OrientGame game, Player p, List<DevelopmentCard> candidates) {
        Map<TokenType, Integer> board = game.getTokens();
        int goldHeld = amount(p.getTokens(), TokenType.Gold);

        // target: the card closest to affordable, preferring prestige
        DevelopmentCard target = null;
        double targetScore = Double.NEGATIVE_INFINITY;
        for (DevelopmentCard c : candidates) {
            if (c.getCostType() == CostType.Bonus || (c.getTokenType() == TokenType.Satchel && !ownsGemCard(p))) {
                continue;
            }
            int gap = Math.max(0, total(missing(p, c)) - goldHeld);
            double score = c.getPrestigePoints() * 2 - gap * 3 + random.nextDouble();
            if (score > targetScore) {
                targetScore = score;
                target = c;
            }
        }
        Map<TokenType, Integer> need = target == null ? new HashMap<>() : missing(p, target);

        HashMap<TokenType, Integer> take = new HashMap<>();
        List<TokenType> needed = new ArrayList<>();
        for (TokenType t : GEMS) {
            if (amount(need, t) > 0 && amount(board, t) > 0) {
                needed.add(t);
            }
        }
        needed.sort(Comparator.comparingInt((TokenType t) -> amount(need, t)).reversed());

        boolean powerTwo = p instanceof TradingPostsPlayer tpp && tpp.extraTokenAfterTakingSameColor.isUnlocked();
        if (!needed.isEmpty() && amount(need, needed.get(0)) >= 2 && amount(board, needed.get(0)) >= 4
                && (needed.size() == 1 || random.nextBoolean())) {
            take.put(needed.get(0), 2);
            if (powerTwo) {
                for (TokenType t : needed) {
                    if (t != needed.get(0)) {
                        take.put(t, 1);
                        break;
                    }
                }
            }
        } else {
            for (TokenType t : needed) {
                if (take.size() < 3) {
                    take.put(t, 1);
                }
            }
            List<TokenType> others = new ArrayList<>();
            for (TokenType t : GEMS) {
                if (!take.containsKey(t) && amount(board, t) > 0) {
                    others.add(t);
                }
            }
            while (take.size() < 3 && !others.isEmpty()) {
                take.put(others.remove(random.nextInt(others.size())), 1);
            }
        }
        if (take.isEmpty()) {
            return null;
        }

        // return tokens to stay at 10: first what the target does not need, gold last
        int excess = total(p.getTokens()) + total(take) - 10;
        HashMap<TokenType, Integer> putBack = new HashMap<>();
        if (excess > 0) {
            Map<TokenType, Integer> hand = new HashMap<>(p.getTokens());
            take.forEach((t, n) -> hand.put(t, amount(hand, t) + n));
            List<TokenType> order = new ArrayList<>(GEMS);
            order.sort(Comparator.comparingInt((TokenType t) -> amount(need, t) - amount(hand, t)));
            order.add(TokenType.Gold);
            for (TokenType t : order) {
                while (excess > 0 && amount(hand, t) - amount(putBack, t) > 0) {
                    putBack.put(t, amount(putBack, t) + 1);
                    excess--;
                }
            }
            // a pure swap that changes nothing is not worth a turn
            if (putBack.equals(take)) {
                return null;
            }
        }
        lastKind = putBack.isEmpty() ? "take" : "take (with put-back)";
        return new TakeTokenAction(take, putBack);
    }
}
