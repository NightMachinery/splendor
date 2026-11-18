import { setCardInspectTarget } from "./card-details.js";

type Card = {
    id: string;
    tokenType?: string;
};

/**
 * Returns the difference of the two cards list.
 * @param oldCards 
 * @param newCards 
 * @returns added cards, deleted cards, changed cards
 */
export const cardsDiff = (oldCards: any[], newCards: any[]): [Card[], Card[], Card[]] => {
    const added: Card[] = [];
    const removed: Card[] = [];
    const changed: Card[] = [];

    const oldCardsMap: Map<string, any> = new Map<string, any>();
    const newCardsMap: Map<string, any> = new Map<string, any>();
    oldCards.forEach(c => oldCardsMap.set(c.id, c));
    newCards.forEach(c => newCardsMap.set(c.id, c));

    // check if new cards were added
    newCards.forEach(c => {
        const oc = oldCardsMap.get(c.id);
        if(!oc) {
            added.push(c);
        } else if(oc.isSatchel && c.isSatchel) {
            // check for changes, could have support for adding custom checks if needed
            if(oc.tokenType !== c.tokenType) {
                changed.push(c);
            }
        }
    });

    // check if cards were removed
    oldCards.forEach(c => {
        const oc = newCardsMap.get(c.id);
        if(!oc) {
            removed.push(c);
        }
    });

    return [added, removed, changed];
};

export const writeCardUpdate = (prefix: string, cards: Card[], imagePath: string, suffix?: Node) => {
    if(cards.length === 0) return;

    const tNode = (document.querySelector("#history-card-template") as HTMLTemplateElement)
                   .content.cloneNode(true) as HTMLDivElement;
    tNode.querySelector(".prefix").textContent = prefix;
    if(suffix) tNode.querySelector(".suffix").append(suffix);
    const imgContainer = tNode.querySelector(".content");
    cards.forEach(c => {
        const img = document.createElement("img");
        img.setAttribute("src", `/images/${imagePath}/${c.id}.jpg`);
        img.alt = "";
        if(imagePath === "development-cards") {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "history-card";
            button.setAttribute("card-id", c.id);
            button.append(img);
            setCardInspectTarget(button, c, { snapshot: true });
            imgContainer.append(button);
        } else {
            imgContainer.append(img);
        }
    });

    appendHistory(tNode.querySelector(".event"));
};

const writeSatchelUpdate = (cards: Card[]) => {
    for (const card of cards) {
        const tokenText = document.createElement("div");
        tokenText.append("is now ", createToken(card.tokenType));
        writeCardUpdate("Bonus of", [card], "development-cards", tokenText);
    }
};

const createToken = (color: string, amount?: number): HTMLElement => {
    const template = document.querySelector<HTMLTemplateElement>("#history-token-template");
    const token = template.content.firstElementChild.cloneNode(true) as HTMLElement;
    const label = color.toLowerCase();
    token.querySelector(".board-token").classList.add(`${label}-token`);
    token.querySelector(".token-label").textContent = amount === undefined ? label : `${amount} ${label}`;
    return token;
};

/**
 * Check if tokens changed between state, write update if yes.
 * @param oldTokens 
 * @param newTokens 
 */
const checkTokens = (oldTokens: Record<string, number>, newTokens: Record<string, number>) => {
    const taken: HTMLElement[] = [];
    const returned: HTMLElement[] = [];

    for (const [color, count] of Object.entries(oldTokens)) {
        const change = newTokens[color] - count;
        if(change > 0) taken.push(createToken(color, change));
        if(change < 0) returned.push(createToken(color, -change));
    }

    for (const [verb, tokens] of [["Took", taken], ["Returned", returned]] as const) {
        if(tokens.length === 0) continue;
        const entry = document.createElement("div");
        entry.append(`${verb} `);
        tokens.forEach((token, index) => {
            if(index > 0) entry.append(", ");
            entry.append(token);
        });
        appendHistory(entry, "token-event");
    }
};

const drawer = document.querySelector<HTMLElement>("#history-events");
const historyContainer = drawer.querySelector(".history-entries");
const latestButton = document.querySelector<HTMLButtonElement>("#history .history-latest");
let followingLatest = true;

const isNearLatest = () => drawer.scrollHeight - drawer.clientHeight - drawer.scrollTop <= 8;

const syncScroll = () => {
    if(followingLatest) drawer.scrollTop = drawer.scrollHeight;
    followingLatest = isNearLatest();
    latestButton.hidden = followingLatest;
};

drawer.addEventListener("scroll", () => {
    followingLatest = isNearLatest();
    latestButton.hidden = followingLatest;
}, { passive: true });

latestButton.addEventListener("click", () => {
    drawer.focus({ preventScroll: true });
    followingLatest = true;
    syncScroll();
});

// Account for new entries, art that finishes loading and drawer resizes.
const resize = new ResizeObserver(syncScroll);
resize.observe(historyContainer);
resize.observe(drawer);

type DisplayNameFor = (username: string) => string;
type FormatHeading = (displayNameFor: DisplayNameFor) => string;
const namedHeadings = new Map<Element, FormatHeading>();

const setNamedHeading = (event: Element, displayNameFor: DisplayNameFor, format: FormatHeading): void => {
    const heading = event.querySelector(".event-name");
    heading.textContent = format(displayNameFor);
    namedHeadings.set(heading, format);
};

export const refreshHistoryNames = (displayNameFor: DisplayNameFor): void => {
    for (const [heading, format] of namedHeadings) {
        const text = format(displayNameFor);
        if(heading.textContent !== text) heading.textContent = text;
    }
};

const startEvent = (username: string, displayNameFor: DisplayNameFor): void => {
    const tNode = (document.querySelector("#history-event-template") as HTMLTemplateElement)
                   .content.cloneNode(true) as HTMLDivElement;
    setNamedHeading(tNode, displayNameFor, nameFor => `${nameFor(username)}’s turn`);

    historyContainer.appendChild(tNode);
};

const appendHistory = (entry: Element, ...classes: string[]): void => {
    const lastEventContainer = historyContainer.querySelector(".event-container:last-child");
    if(!lastEventContainer) {
        console.log("append history called but no event has been made");
        return;
    }

    entry.classList.add("event", ...classes);
    lastEventContainer.querySelector(".event-content").appendChild(entry);
};

/**
 * Writes out who's turn it is, only if the current player has changed.
 * @param last 
 * @param current 
 */
const writeCurrentTurn = (last: any, current: any, displayNameFor: DisplayNameFor): void => {
    if(current.gameOver) {
        return;
    }

    if(!last || current.players[current.turnCounter].name !== last.players[last.turnCounter].name) {
        startEvent(current.players[current.turnCounter].name, displayNameFor);
    }
};

const writeGameOver = (data: any, displayNameFor: DisplayNameFor): void => {
    const tNode = (document.querySelector("#history-event-template") as HTMLTemplateElement)
                   .content.cloneNode(true) as HTMLDivElement;

    const overNode = (document.querySelector("#history-event-template") as HTMLTemplateElement)
                   .content.cloneNode(true) as HTMLDivElement;
    overNode.querySelector(".event-name").textContent = "The game has ended.";

    const winnerIds: string[] = data.winners.map((player: { name: string }) => player.name);
    setNamedHeading(tNode, displayNameFor, nameFor => {
        const names = winnerIds.map(nameFor);
        if(names.length === 1) return `🎉 ${names[0]} is the winner! 🎉`;
        const text = names.length == 2 ? names.join(" and ") : names.join(", ");
        return `🎉 ${text} are the winners! 🎉`;
    });

    historyContainer.appendChild(overNode);
    historyContainer.appendChild(tNode);
};

const playerUpdaters = [];
export const registerPlayerUpdater = (func: (oldState: any, newState: any) => {}): void => {
    playerUpdaters.push(func);
};

const gameUpdaters = [];
export const registerGameUpdater = (func: (oldState: any, newState: any) => {}): void => {
    gameUpdaters.push(func);
};

export const writeUpdate = (last: any, current: any, displayNameFor: DisplayNameFor): void => {
    if(current.gameOver && !last) {
        writeGameOver(current, displayNameFor);
    }

    if(!last) {
        writeCurrentTurn(last, current, displayNameFor);
        return;
    }

    // they should always have the same number of players
    const oldPlayerState: Map<string, any> = new Map<string, any>();
    last.players.forEach(p => oldPlayerState.set(p.name, p));
    current.players.forEach((newState) => {
        const oldState = oldPlayerState.get(newState.name);
        checkTokens(oldState.tokens, newState.tokens);

        // dev cards
        {
            const [newCards, oldCards, changedCards] = cardsDiff(oldState.devCards, newState.devCards);
            writeCardUpdate("Obtained", newCards, "development-cards");
            writeCardUpdate("Used", oldCards, "development-cards");
            writeSatchelUpdate(changedCards);
        }

        // reserved dev
        writeCardUpdate("Reserved", cardsDiff(oldState.reservedCards, newState.reservedCards)[0], "development-cards");

        // nobles
        writeCardUpdate("Visited by", cardsDiff(oldState.nobleCards, newState.nobleCards)[0], "nobles");

        // reserved nobles
        writeCardUpdate("Reserved", cardsDiff(oldState.reservedNobles, newState.reservedNobles)[0], "nobles");

        playerUpdaters.forEach(func => func(oldState, newState));
    });

    gameUpdaters.forEach(func => func(last, current));

    writeCurrentTurn(last, current, displayNameFor);
    if(current.gameOver) {
        writeGameOver(current, displayNameFor);
    }
};

export const writeBasicUpdate = (text: string): void => {
    const textNode = document.createElement("div");
    textNode.textContent = text;
    appendHistory(textNode, "card-event");
};
