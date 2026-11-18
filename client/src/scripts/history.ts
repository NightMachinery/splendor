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

type TokenChange = [color: string, amount: number];
type Entry =
    | { type: "cards"; prefix: string; cards: Card[]; imagePath: string; bonusColor?: string }
    | { type: "tokens"; verb: string; tokens: TokenChange[] }
    | { type: "text"; text: string };
type Heading =
    | { type: "turn"; username: string }
    | { type: "finished" }
    | { type: "winners"; usernames: string[] };
type Section = { heading: Heading; entries: Entry[] };

const createToken = (color: string, amount?: number): HTMLElement => {
    const template = document.querySelector<HTMLTemplateElement>("#history-token-template");
    const token = template.content.firstElementChild.cloneNode(true) as HTMLElement;
    const label = color.toLowerCase();
    token.querySelector(".board-token").classList.add(`${label}-token`);
    token.querySelector(".token-label").textContent = amount === undefined ? label : `${amount} ${label}`;
    return token;
};

const renderCards = ({ prefix, cards, imagePath, bonusColor }: Extract<Entry, { type: "cards" }>): Element => {
    const template = document.querySelector<HTMLTemplateElement>("#history-card-template");
    const entry = template.content.firstElementChild.cloneNode(true) as HTMLElement;
    entry.querySelector(".prefix").textContent = prefix;
    if(bonusColor) entry.querySelector(".suffix").append("is now ", createToken(bonusColor));
    const images = entry.querySelector(".content");
    for (const card of cards) {
        const img = document.createElement("img");
        img.src = `/images/${imagePath}/${encodeURIComponent(card.id)}.jpg`;
        img.alt = "";
        if(imagePath === "development-cards") {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "history-card";
            button.setAttribute("card-id", card.id);
            button.append(img);
            setCardInspectTarget(button, card, { snapshot: true });
            images.append(button);
        } else {
            images.append(img);
        }
    }
    return entry;
};

const renderEntry = (entry: Entry): Element => {
    if(entry.type === "cards") return renderCards(entry);
    const node = document.createElement("div");
    if(entry.type === "tokens") {
        node.className = "event token-event";
        node.append(`${entry.verb} `);
        entry.tokens.forEach(([color, amount], index) => {
            if(index > 0) node.append(", ");
            node.append(createToken(color, amount));
        });
    } else {
        node.className = "event card-event";
        node.textContent = entry.text;
    }
    return node;
};

export const writeCardUpdate = (prefix: string, cards: Card[], imagePath: string, bonusColor?: string) => {
    if(cards.length) appendHistory({ type: "cards", prefix, cards, imagePath, bonusColor });
};

const writeSatchelUpdate = (cards: Card[]) => {
    for (const card of cards) {
        writeCardUpdate("Bonus of", [card], "development-cards", card.tokenType);
    }
};

const checkTokens = (oldTokens: Record<string, number>, newTokens: Record<string, number>) => {
    const taken: TokenChange[] = [];
    const returned: TokenChange[] = [];
    for (const [color, count] of Object.entries(oldTokens)) {
        const change = newTokens[color] - count;
        if(change > 0) taken.push([color, change]);
        if(change < 0) returned.push([color, -change]);
    }
    if(taken.length) appendHistory({ type: "tokens", verb: "Took", tokens: taken });
    if(returned.length) appendHistory({ type: "tokens", verb: "Returned", tokens: returned });
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
const sections: Section[] = [];

const headingText = (heading: Heading, displayNameFor: DisplayNameFor): string => {
    if(heading.type === "turn") return `${displayNameFor(heading.username)}’s turn`;
    if(heading.type === "finished") return "The game has ended.";
    const names = heading.usernames.map(displayNameFor);
    if(names.length === 1) return `🎉 ${names[0]} is the winner! 🎉`;
    return `🎉 ${names.join(names.length === 2 ? " and " : ", ")} are the winners! 🎉`;
};

export const refreshHistoryNames = (displayNameFor: DisplayNameFor): void => {
    sections.forEach(({ heading }, index) => {
        const node = historyContainer.children[index].querySelector(".event-name");
        const text = headingText(heading, displayNameFor);
        if(node.textContent !== text) node.textContent = text;
    });
};

const appendSection = (section: Section, displayNameFor: DisplayNameFor): void => {
    const template = document.querySelector<HTMLTemplateElement>("#history-event-template");
    const node = template.content.firstElementChild.cloneNode(true) as HTMLElement;
    node.querySelector(".event-name").textContent = headingText(section.heading, displayNameFor);
    node.querySelector(".event-content").append(...section.entries.map(renderEntry));
    historyContainer.append(node);
    sections.push(section);
};

const appendHistory = (entry: Entry): void => {
    const section = sections.at(-1);
    if(!section) return;
    historyContainer.lastElementChild.querySelector(".event-content").append(renderEntry(entry));
    section.entries.push(entry);
};

const writeCurrentTurn = (last: any, current: any, displayNameFor: DisplayNameFor): void => {
    if(current.gameOver) return;
    const username = current.players[current.turnCounter].name;
    if(username !== last?.players[last.turnCounter]?.name) {
        appendSection({ heading: { type: "turn", username }, entries: [] }, displayNameFor);
    }
};

const writeGameOver = (data: any, displayNameFor: DisplayNameFor): void => {
    const usernames = data.winners.map((player: { name: string }) => player.name);
    appendSection({ heading: { type: "finished" }, entries: [] }, displayNameFor);
    appendSection({ heading: { type: "winners", usernames }, entries: [] }, displayNameFor);
};

const playerUpdaters = [];
export const registerPlayerUpdater = (func: (oldState: any, newState: any) => {}): void => {
    playerUpdaters.push(func);
};

const gameUpdaters = [];
export const registerGameUpdater = (func: (oldState: any, newState: any) => {}): void => {
    gameUpdaters.push(func);
};

const writeUpdate = (last: any, current: any, displayNameFor: DisplayNameFor): void => {
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

export const writeBasicUpdate = (text: string): void => appendHistory({ type: "text", text });

const storageKey = "splendor:history:v1";
type Checkpoint = { scope: string; hash: string; state: any; sections: Section[] };
let checkpoint: Checkpoint | undefined;
let loaded = false;

const clearHistory = (): void => {
    historyContainer.replaceChildren();
    sections.length = 0;
    followingLatest = true;
    checkpoint = undefined;
};

// The same renderer restores entries, including inspector targets, from plain data.
const restoreHistory = (scope: string, current: any, displayNameFor: DisplayNameFor): void => {
    try {
        const raw = sessionStorage.getItem(storageKey);
        if(!raw) return;
        const saved: Checkpoint = JSON.parse(raw);
        if(saved.scope !== scope || saved.state?.gameInstanceId !== current.gameInstanceId) return;
        if(typeof saved.hash !== "string" || !Array.isArray(saved.state?.players) || !saved.sections?.length) return;
        for (const section of saved.sections) appendSection(section, displayNameFor);
        checkpoint = saved;
    } catch {
        clearHistory();
    }
};

export const updateHistory = (scope: string, current: any, hash: string, displayNameFor: DisplayNameFor): void => {
    if(!loaded) {
        loaded = true;
        restoreHistory(scope, current, displayNameFor);
    }
    if(checkpoint && (checkpoint.scope !== scope || checkpoint.state.gameInstanceId !== current.gameInstanceId)) {
        clearHistory();
    }
    if(checkpoint?.hash === hash) return;

    const count = sections.length;
    const lastSection = sections.at(-1);
    const lastContent = historyContainer.lastElementChild?.querySelector(".event-content");
    const entryCount = lastSection?.entries.length ?? 0;
    try {
        writeUpdate(checkpoint?.state, current, displayNameFor);
    } catch(error) {
        // A poll may retry. Roll back any headings or entries from this update.
        while(sections.length > count) {
            sections.pop();
            historyContainer.lastElementChild.remove();
        }
        if(lastSection) {
            lastSection.entries.length = entryCount;
            while(lastContent.children.length > entryCount) lastContent.lastElementChild.remove();
        }
        throw error;
    }
    checkpoint = { scope, hash, state: current, sections };
    try {
        sessionStorage.setItem(storageKey, JSON.stringify(checkpoint));
    } catch {
        // History remains readable in the live board if storage is unavailable.
    }
};
