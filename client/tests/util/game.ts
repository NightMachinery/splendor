// Builders for Game Service state in the exact JSON shape the server sends.
//
// The server serialises its model with plain Gson reflection
// (SplendorTypeAdapter.newClientGson), so the state is just the fields of
// OrientGame / OrientPlayer / the card classes. Keep these classes to data
// fields only: anything enumerable ends up in the JSON the client parses.

import { card as catalogCard } from "../fixtures/cards.mjs";

export const CostType = {
    Token: "Token",
    Bonus: "Bonus"
} as const;
export type CostType = typeof CostType[keyof typeof CostType];

export const TokenType = {
    Green: "Green",
    White: "White",
    Blue: "Blue",
    Brown: "Brown",
    Red: "Red",
    Gold: "Gold",
    Satchel: "Satchel"
} as const;
export type TokenType = typeof TokenType[keyof typeof TokenType];
export const allTokens: TokenType[] = [
    TokenType.Green, TokenType.White, TokenType.Blue, TokenType.Brown,
    TokenType.Red, TokenType.Gold, TokenType.Satchel
];

export const CascadeType = {
    Tier1: "Tier1", Tier2: "Tier2", None: "None"
} as const;
export type CascadeType = typeof CascadeType[keyof typeof CascadeType];

export type CardTier = "TIER_1" | "TIER_2" | "TIER_3";

export const Actions = {
    BUY_CARD: "BUY_CARD",
    TAKE_TOKEN: "TAKE_TOKEN",
    RESERVE_CARD: "RESERVE_CARD",
    CHOOSE_NOBLE: "CHOOSE_NOBLE",

    // Orient
    CASCADE_1: "CASCADE_1",
    CASCADE_2: "CASCADE_2",
    RESERVE_NOBLE: "RESERVE_NOBLE",
    CHOOSE_SATCHEL_TOKEN: "CHOOSE_SATCHEL_TOKEN",

    // Trading posts
    TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER: "TAKE_EXTRA_TOKEN_AFTER_PURCHASE_POWER",

    // Cities
    CHOOSE_CITY: "CHOOSE_CITY",
} as const;
export type Actions = typeof Actions[keyof typeof Actions];

/** A HashMap<TokenType, Integer>: every TokenType key present. */
export class TokensCount {
    Green = 0;
    White = 0;
    Blue = 0;
    Brown = 0;
    Red = 0;
    Satchel = 0;
    Gold = 0;

    reset(): this {
        for (const tt of allTokens) this[tt] = 0;
        return this;
    }

    setCount(tokenType: TokenType, count: number): this {
        this[tokenType] = count;
        return this;
    }
}

class Player {
    name: string;
    colour = "1E90FF";
    prestigePoints = 0;
    tokens = new TokensCount();
    bonuses = new TokensCount();
    devCards: Array<DevCard | Record<string, unknown>> = [];
    nobleCards: Array<Card | Record<string, unknown>> = [];
    reservedCards: Array<DevCard | Record<string, unknown>> = [];
    reservedNobles: Array<Card | Record<string, unknown>> = [];

    constructor(name: string) {
        this.name = name;
    }
}

class Card {
    id: string;
    prestigePoints = 0;
    costType: CostType = CostType.Token;
    tokenCost = new TokensCount();

    constructor(id: string) {
        this.id = id;
    }

    setCostType(costType: CostType): this {
        this.costType = costType;
        return this;
    }
}

export class NobleCard extends Card {
    constructor(id: string) {
        super(id);
        this.prestigePoints = 3;
        this.costType = CostType.Bonus;
    }
}

export class DevCard extends Card {
    tokenType: TokenType;
    bonus: number;
    cardTier: CardTier;

    constructor(id: string, tokenType: TokenType, bonusAmount = 1, cardTier: CardTier = "TIER_1") {
        super(id);
        this.tokenType = tokenType;
        this.bonus = bonusAmount;
        this.cardTier = cardTier;
    }
}

export class OrientDevCard extends DevCard {
    reserveNoble = false;
    isSatchel: boolean;
    cascadeType: CascadeType = CascadeType.None;

    constructor(id: string, tokenType: TokenType, bonusAmount = 1, cardTier: CardTier = "TIER_1") {
        super(id, tokenType, bonusAmount, cardTier);
        this.isSatchel = tokenType === TokenType.Satchel;
    }
}

type AnyCard = Card | Record<string, unknown>;

class Deck<T extends AnyCard> {
    visibleCards: Array<T> = [];
    canDraw = false;
    // private (#) so it never reaches the JSON
    #limit: number;

    constructor(limit: number) {
        this.#limit = limit;
    }

    setLimit(limit: number): this {
        this.#limit = limit;
        return this;
    }

    setCanDraw(canDraw: boolean): this {
        this.canDraw = canDraw;
        return this;
    }

    addOrReplace(card: T): this {
        if (this.visibleCards.length >= this.#limit) {
            this.visibleCards[0] = card;
        } else {
            this.visibleCards.push(card);
        }
        return this;
    }

    getOne(): T {
        return this.visibleCards[0];
    }

    reset(): this {
        this.visibleCards = [];
        return this;
    }
}

export type GameVersion = "BASE_ORIENT" | "BASE_ORIENT_CITIES" | "BASE_ORIENT_CITIES_NOBLES" | "BASE_ORIENT_TRADE_ROUTES";

export class Game {
    gameVersion: GameVersion = "BASE_ORIENT";
    prestigePointsToWin = 15;
    turnCounter = 0;
    curValidActions: Array<Actions> = [];
    players: Array<Player> = [];
    tier1Deck = new Deck<AnyCard>(4);
    tier2Deck = new Deck<AnyCard>(4);
    tier3Deck = new Deck<AnyCard>(4);
    tier1OrientDeck = new Deck<AnyCard>(2);
    tier2OrientDeck = new Deck<AnyCard>(2);
    tier3OrientDeck = new Deck<AnyCard>(2);
    nobleDeck = new Deck<AnyCard>(3);
    tokens = new TokensCount();
    playersWhoCanWin: Array<Player> = [];
    winners: Array<Player> = [];
    gameOver = false;

    addPlayer(...names: string[]): this {
        for (const name of names) {
            this.players.push(new Player(name));
        }
        this.nobleDeck.setLimit(this.players.length + 1);
        return this;
    }

    getPlayer(name: string): Player {
        const p = this.players.find((pl) => pl.name === name);
        if (!p) throw new ReferenceError("Player does not exist");
        return p;
    }

    setTurnCounter(turn: number): this {
        this.turnCounter = turn;
        return this;
    }

    resetValidActions(): this {
        this.curValidActions = [];
        return this;
    }

    addAction(...action: Actions[]): this {
        this.curValidActions = [...this.curValidActions, ...action];
        return this;
    }

    addDefaultActions(): this {
        this.addAction(Actions.BUY_CARD, Actions.TAKE_TOKEN, Actions.RESERVE_CARD);
        return this;
    }

    /** End the game the way OrientGame does: winners set, turnCounter -10000, no actions. */
    finish(...winnerNames: string[]): this {
        this.gameOver = true;
        this.winners = winnerNames.map((n) => this.getPlayer(n));
        this.playersWhoCanWin = [...this.winners];
        this.turnCounter = -10000;
        this.curValidActions = [];
        return this;
    }
}

/** A deep copy of a real card from the server catalog (server/src/main/resources/cards.csv). */
export const realCard = (id: string): Record<string, unknown> => catalogCard(id);

// Real ids, so the board loads real images (public/images/development-cards/<id>.jpg).
const BOARD_IDS = {
    tier1Deck: ["01", "02", "03", "04"],
    tier2Deck: ["041", "042", "043", "044"],
    tier3Deck: ["071", "072", "073", "074"],
    tier1OrientDeck: ["091", "096"],
    tier2OrientDeck: ["101", "106"],
    tier3OrientDeck: ["111", "116"],
} as const;

/** Two players ("linus" to move, "maex"), a full 2-player board, the three main actions available. */
export const createBasicGame = (): Game => {
    const game = new Game()
        .addDefaultActions()
        .addPlayer("linus", "maex");

    for (const id of ["20002", "20003", "20004"]) game.nobleDeck.addOrReplace(realCard(id));

    for (const tt of [TokenType.Green, TokenType.White, TokenType.Blue, TokenType.Brown, TokenType.Red]) {
        game.tokens.setCount(tt, 4);
    }
    game.tokens.setCount(TokenType.Gold, 5);

    for (const [deck, ids] of Object.entries(BOARD_IDS) as Array<[keyof typeof BOARD_IDS, readonly string[]]>) {
        for (const id of ids) game[deck].addOrReplace(realCard(id));
        game[deck].setCanDraw(true);
    }

    return game;
};

/** createBasicGame plus the Cities fields (CitiesGame / CitiesPlayer). Nobles are kept unless `withNobles` is false. */
export const createCitiesGame = (withNobles = false): Game => {
    const game = createBasicGame();
    game.gameVersion = withNobles ? "BASE_ORIENT_CITIES_NOBLES" : "BASE_ORIENT_CITIES";
    game.prestigePointsToWin = -1;
    if (!withNobles) game.nobleDeck.reset();
    Object.assign(game, {
        citiesDeck: { visibleCards: ["40001", "40007", "40008"].map(realCard), canDraw: true },
    });
    for (const p of game.players) Object.assign(p, { cities: [], citiesQualifiedFor: [] });
    return game;
};

/** createBasicGame plus the Trading Posts fields (TradingPostsPlayer powers). */
export const createTradingPostsGame = (): Game => {
    const game = createBasicGame();
    game.gameVersion = "BASE_ORIENT_TRADE_ROUTES";
    for (const p of game.players) {
        Object.assign(p, {
            coatsOfArmsUnplaced: 5,
            extraTokenAfterPurchase: { unlocked: false },
            extraTokenAfterTakingSameColor: { unlocked: false },
            goldTokenWorthTwoTokens: { unlocked: false },
            addFivePrestigePoints: { isUsed: false, unlocked: false },
            addPrestigePointsWithCoatsOfArms: { currentAddedPoints: 0, unlocked: false },
        });
    }
    return game;
};
