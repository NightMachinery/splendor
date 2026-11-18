import { SETTINGS, createLongPoll, fetchWithTimeout, LS_HOLDS_REQUESTS } from "./settings.js";
import { startTurn, verifyNoModals, performFollowUpAction, showNextModal } from "./modals/modals.js";
import { animateMoveToken } from "./animation/tokens";
import { moveCardFromDeck, moveCard, moveCardReserved } from "./animation/cards";
import { writeUpdate } from "./history";
import { runDelayed } from "./animation/utils";
import { showError } from "./notify.js";
import { initGameOver } from "./modals/gameover.js";

import { md5Hex } from "./local-md5.js";
import {
    playerAlias, isObserver, renderPlayerBadges, renderModerationActions
} from "./moderation-ui.js";

let currentLobbySession = null;

const getSessionId = () => (new URL(document.location)).searchParams.get("sessionId");

/**
 * The game-state poll keeps running in a hidden tab, so that a waiting
 * player's background tab learns that it is their turn. anime.js suspends
 * while the page is hidden, so an animation started then would only play
 * (and only reveal its card or count) once the tab is visible again, and
 * several of them could finish out of order. Renders in a hidden tab
 * therefore skip the animations and show the end state at once.
 */
const animationsSuspended = () => typeof document !== "undefined" && document.hidden;

/**
 * Whether a parsed reply looks like a Lobby Service session (and not, say, a
 * game state that a test mock served for the same URL pattern).
 */
const isLobbySession = (data) => !!data && typeof data === "object"
    && typeof data.creator === "string" && Array.isArray(data.players) && !!data.gameParameters;

const updateTurnStatus = (state) => {
    const name = state.players[state.turnCounter]?.name;
    const status = document.querySelector("#game-turn-status");
    const text = state.gameOver ? "Game over" : !name ? "" : name === SETTINGS.getUsername()
        ? "Your turn"
        : `${playerAlias(currentLobbySession, name)}’s turn`;
    if(status && status.textContent !== text) status.textContent = text;
};

/**
 * One-shot fetch of the lobby session (aliases, observers, moderators).
 * Never throws; keeps the previous value on any failure.
 *
 * @returns {Promise<{session: object|null, hash: string|null}>}
 */
const fetchLobbySession = async (sessionId) => {
    if(!sessionId) return { session: currentLobbySession, hash: null };
    try {
        const resp = await fetchWithTimeout(`${SETTINGS.getLS_API()}/api/sessions/${sessionId}`, {}, 10000);
        if(!resp.ok || resp.status === 204) return { session: currentLobbySession, hash: null };
        const text = await resp.text();
        const data = JSON.parse(text);
        if(!isLobbySession(data)) return { session: currentLobbySession, hash: null };
        return { session: data, hash: md5Hex(text) };
    } catch(err) {
        console.log("Could not fetch lobby session metadata: " + err);
        return { session: currentLobbySession, hash: null };
    }
};

const refreshGameModerationChrome = (state = currentState) => {
    if(!state || !currentLobbySession) return;
    updateTurnStatus(state);
    const sessionId = (new URL(document.location)).searchParams.get("sessionId");
    state.players.forEach((playerInfo) => {
        const pNode = document.querySelector(`.other-players .other-player[pname="${playerInfo.name}"]`);
        if(pNode) {
            pNode.classList.toggle("self", playerInfo.name === SETTINGS.getUsername());
            pNode.classList.toggle("observer", isObserver(currentLobbySession, playerInfo.name));
            pNode.querySelector(".other-player-name").textContent = playerAlias(currentLobbySession, playerInfo.name);
            const badges = pNode.querySelector(".game-player-badges");
            if(badges) renderPlayerBadges(badges, currentLobbySession, playerInfo.name, "game-player-badge");
            const controls = pNode.querySelector(".game-player-mod-controls");
            if(controls) renderModerationActions(controls, currentLobbySession, sessionId, playerInfo.name, { afterAction: refreshLobbySessionAndChrome });
        }
        if(playerInfo.name === SETTINGS.getUsername()) {
            const modPanel = document.querySelector("#player-inventory .player-inventory-mod-panel");
            if(modPanel) {
                modPanel.querySelector(".self-name").textContent = playerAlias(currentLobbySession, playerInfo.name);
                renderPlayerBadges(modPanel.querySelector(".game-player-badges"), currentLobbySession, playerInfo.name, "game-player-badge");
                renderModerationActions(modPanel.querySelector(".game-player-mod-controls"), currentLobbySession, sessionId, playerInfo.name, { afterAction: refreshLobbySessionAndChrome });
            }
        }
    });
};

const refreshLobbySessionAndChrome = async () => {
    const { session } = await fetchLobbySession(getSessionId());
    currentLobbySession = session;
    refreshGameModerationChrome();
};

const updateTokensCount = (parentSelector, tokenInfo, bonusInfo = null) => {
    const parentNode = document.querySelector(parentSelector);

    const setTokenInfo = (elm, color) => {
        // The count the latest render asked for. An animation from an earlier
        // render that finishes later must not put back an older count, so the
        // text is always set from here, and deltas are taken from it too.
        const previousTarget = elm.dataset.count !== undefined ? parseInt(elm.dataset.count) : parseInt(elm.textContent);
        elm.dataset.count = String(tokenInfo[color]);
        const updateText = () => elm.textContent = elm.dataset.count;

        // set bonus
        if(bonusInfo) {
            // get bonus container
            elm.closest(".bonus-container").querySelector(".bonus-icon > span").textContent = bonusInfo[color];

            const hasCount = previousTarget;
            const newCount = tokenInfo[color];
            if(animationsSuspended()) {
                updateText();
            } else if(hasCount !== newCount) {
                // animate tokens moving
                // slight delay so that the player inventory will be correct size
                runDelayed(() => animateMoveToken(newCount - hasCount, color, parentSelector, "#board .board-tokens", updateText));
            }
        } else {
            updateText(); // update text immediately
        }
    };
    const colors = ["Red", "Blue", "Green", "White", "Brown", "Gold"];

    colors.forEach((col) => {
        setTokenInfo(parentNode.querySelector(`.${col.toLowerCase()}-token > span`), col);
    });
};

const updateTierRow = (selector, devCardsDeck, orientCardsDeck) => {
    const devCards = devCardsDeck.visibleCards;
    const orientCards = orientCardsDeck.visibleCards;
    const row = document.querySelector(selector);

    const updateCardElement = (deckSelector, cardSelector, freeCardElm, cardInfo) => {
        const cardId = cardInfo["id"];
        const cost = cardInfo["tokenCost"];

        const imgUrl = `/images/development-cards/${cardId}.jpg`;
        const imgElm = freeCardElm.querySelector("img");
        imgElm.src = imgUrl;

        // add additional info
        freeCardElm.setAttribute("card-id", cardId);
        freeCardElm.setAttribute("cost", JSON.stringify(cost));

        if(animationsSuspended()) {
            imgElm.classList.remove("invisible");
            return;
        }
        imgElm.classList.add("invisible");

        // slight timeout to ensure no content shift
        // only delay if deck is not invisible
        const shouldDelay = document.querySelector(`${selector} ${deckSelector}`).getAttribute("empty") !== null;
        moveCardFromDeck(`${selector} ${deckSelector}`, `${selector} ${cardSelector}[card-id="${cardId}"]`, shouldDelay);
    };

    // clear images first
    const clearIfNeeded = (cards, cardSelector, deckSelector) => {
        const serverCardIds = cards.map(c => c.id);
        const currentCardIds = [...row.querySelectorAll(`${cardSelector}[card-id]`)]
                                       .map(elm => elm.getAttribute("card-id"));

        // cards that exist on board but not server side, must remove
        const outdatedCardIds = currentCardIds.filter(x => !serverCardIds.includes(x));
        outdatedCardIds.forEach(cid => {
            const oldElm = row.querySelector(`${selector} ${cardSelector}[card-id="${cid}"]`);
            oldElm.removeAttribute("card-id");
            oldElm.removeAttribute("cost");
            oldElm.querySelector("img").removeAttribute("src");
        });

        const missingCards = cards.filter(c => !currentCardIds.includes(c.id));
        missingCards.forEach(card => {
            // select empty ones to fill
            const emptyCardElm = document.querySelector(`${selector} ${cardSelector}:not([card-id])`);
            updateCardElement(deckSelector, cardSelector, emptyCardElm, card);
        });
    };
    clearIfNeeded(devCards, ".board-card-dev:not(.board-card-dev-orient)", ".board-cards-dev-deck");
    clearIfNeeded(orientCards, ".board-card-dev.board-card-dev-orient", ".board-cards-dev-deck-orient");

    // mark deck as empty if needed
    const setEmptyIfNeeded = (deckSelector, canDraw) => {
        if(!canDraw) {
            row.querySelector(deckSelector).setAttribute("empty", "true");
        }
    };
    
    setEmptyIfNeeded(".board-cards-dev-deck", devCardsDeck.canDraw);
    setEmptyIfNeeded(".board-cards-dev-deck-orient", orientCardsDeck.canDraw);
};

/**
 * Update a series of cards with the given array.
 * 
 * @param {Array} cards list of cards
 * @param {HTMLElement} baseElement base element for all other selectors
 * @param {string} containerSelector container selector for all cards
 * @param {string} cardSelector selector for single card
 * @param {string} imageFolder folder name for images
 * @param {string} cardTemplateSelector template for card (could become just an HTMLElement name todo)
 */
export const updateCards = (cards, baseElement, containerSelector, cardSelector, imageFolder, cardTemplateSelector) => {

    const cardContainer = baseElement.querySelector(containerSelector);

    const currentCardIds = [];
    cardContainer.querySelectorAll(cardSelector).forEach(elm => currentCardIds.push(elm.getAttribute("card-id")));

    // server state cards
    const serverCardIds = cards.map(c => c.id);

    // cards that exist in inv but not server side, must remove
    const outdatedCardIds = currentCardIds.filter(x => !serverCardIds.includes(x));
    outdatedCardIds.forEach(cid => cardContainer.querySelector(`${cardSelector}[card-id="${cid}"]`).remove());

    // add new reserved cards to inv
    const missingCardIds = serverCardIds.filter(x => !currentCardIds.includes(x));
    missingCardIds.forEach(cid => {
        const tNode = document.querySelector(cardTemplateSelector).content.cloneNode(true);
        const div = tNode.querySelector("div");
        const imgUrl = `/images/${imageFolder}/${cid}.jpg`;

        div.setAttribute("card-id", cid);
        const imgElm = div.querySelector("img");
        imgElm.setAttribute("src", imgUrl);

        // add to inv
        cardContainer.appendChild(tNode);

        // since this will be called before removing the card from the board,
        // we can check if the card already exists on the board,
        // if yes => make it invisible and queue move animation
        // else don't animate or make invisible
        const boardCardSel = document.querySelector(`.board-container *[card-id="${cid}"]`)
                             || document.querySelector(`.board *[card-id="${cid}"]`); // for regular base + orient board
        if(boardCardSel && !animationsSuspended()) {
            imgElm.classList.add("invisible");

            // slight delay so that the player inventory will be correct size
            if(containerSelector.includes("reserve")) {
                moveCardReserved(boardCardSel, cardContainer.querySelector(`*[card-id="${cid}"]`), `${imageFolder}/${cid}.jpg`, true);
            } else {
                moveCard(boardCardSel, cardContainer.querySelector(`*[card-id="${cid}"]`), `${imageFolder}/${cid}.jpg`, true);
            }
        }
    });
};

const updateMainPlayerInfo = (playerInfo) => {

    const playerInv = document.querySelector("#player-inventory");


    // update prestige points
    playerInv.querySelector(".player-prestige-points-container > span").textContent = playerInfo.prestigePoints;

    // why
    const tokenMap = playerInfo.tokens;
    updateTokensCount(".player-inventory-tokens", tokenMap, playerInfo.bonuses);

    // UPDATE DEVELOPMENT CARDS IN PLAYER INVENTORY
    updateCards(playerInfo.devCards, playerInv, ".player-inventory-card-drawer",
                ".player-inventory-card", "development-cards", "#development-card-template");

    // mark cards as satchel (so that we can select them later in the choose satchel token type)
    playerInfo.devCards.forEach((c) => {
        const card = document.querySelector(`.player-inventory-card-drawer .player-inventory-card[card-id="${c.id}"]`);
        if(c.tokenType === "Satchel") {
            card.setAttribute("satchel", "true");
        } else if(c.tokenType !== "Satchel" && card.hasAttribute("satchel")) {
            card.removeAttribute("satchel");
        }
    });


    // UPDATE RESERVED CARDS IN PLAYER INVENTORY
    updateCards(playerInfo.reservedCards, playerInv, ".player-inventory-reservedcards",
                ".player-inventory-card-reserved", "development-cards", "#player-inventory-reserved-card-template");

    // Update nobles
    updateCards(playerInfo.nobleCards, playerInv, ".player-inventory-nobles",
                ".noble-card", "nobles", "#noble-card-template");

    // Update reserved nobles
    updateCards(playerInfo.reservedNobles, playerInv, ".player-inventory-reserved-nobles",
                ".noble-card", "nobles", "#noble-card-template");

    // shrink player inventory if too much crap
    let containerCount = 0;
    if(playerInfo.devCards.length > 0) containerCount++;
    if(playerInfo.reservedCards.length > 0) containerCount++;
    if(playerInfo.nobleCards.length > 0) containerCount++;
    if(playerInfo.reservedNobles.length > 0) containerCount++;

    if(containerCount > 2) {
        playerInv.classList.add("shrink");
    } else {
        playerInv.classList.remove("shrink");
    }

    let modPanel = playerInv.querySelector(".player-inventory-mod-panel");
    if(!modPanel) {
        modPanel = document.createElement("div");
        modPanel.className = "player-inventory-mod-panel";
        modPanel.innerHTML = `<div class="self-name"></div><div class="game-player-badges"></div><div class="game-player-mod-controls"></div>`;
        playerInv.querySelector(".player-inventory-container").appendChild(modPanel);
    }
    modPanel.querySelector(".self-name").textContent = playerAlias(currentLobbySession, playerInfo.name);
    renderPlayerBadges(modPanel.querySelector(".game-player-badges"), currentLobbySession, playerInfo.name, "game-player-badge");
    const sessionId = (new URL(document.location)).searchParams.get("sessionId");
    renderModerationActions(modPanel.querySelector(".game-player-mod-controls"), currentLobbySession, sessionId, playerInfo.name, { afterAction: refreshLobbySessionAndChrome });
};

const updateOtherPlayerInfo = (pInfo) => {
    const selector = `.other-players .other-player[pname="${pInfo.name}"]`;
    let pNode = document.querySelector(selector);

    // if node doesn't exist, we must make
    if(!pNode) {
        const tNode = document.querySelector("#other-player-tab-template").content.cloneNode(true);
        const pDiv = tNode.querySelector(".other-player");

        pDiv.setAttribute("pname", pInfo.name);
        pDiv.querySelector(".other-player-name").textContent = playerAlias(currentLobbySession, pInfo.name);

        document.querySelector(".other-players").appendChild(tNode);

        // now reget the node
        pNode = document.querySelector(selector);
    }

    pNode.classList.toggle("self", pInfo.name === SETTINGS.getUsername());
    pNode.classList.toggle("observer", isObserver(currentLobbySession, pInfo.name));
    pNode.querySelector(".other-player-name").textContent = playerAlias(currentLobbySession, pInfo.name);

    let badges = pNode.querySelector(".game-player-badges");
    if(!badges) {
        badges = document.createElement("div");
        badges.className = "game-player-badges";
        pNode.querySelector(".other-player-profile").appendChild(badges);
    }
    renderPlayerBadges(badges, currentLobbySession, pInfo.name, "game-player-badge");

    let controls = pNode.querySelector(".game-player-mod-controls");
    if(!controls) {
        controls = document.createElement("div");
        controls.className = "game-player-mod-controls";
        pNode.querySelector(".other-player-profile").appendChild(controls);
    }
    const sessionId = (new URL(document.location)).searchParams.get("sessionId");
    renderModerationActions(controls, currentLobbySession, sessionId, pInfo.name, { afterAction: refreshLobbySessionAndChrome });

    // update tokens, cards, prestige points
    const tokenMap = pInfo.tokens;
    updateTokensCount(selector, tokenMap, pInfo.bonuses);


    // UPDATE DEVELOPMENT CARDS IN OTHER PLAYER INVENTORIES
    updateCards(pInfo.devCards, pNode, ".other-inventory-cards",
                ".other-inventory-card", "development-cards", "#other-player-dev-card-template");

    // UPDATE RESERVED CARDS IN OTHER PLAYER INVENTORIES
    updateCards(pInfo.reservedCards, pNode, ".other-inventory-cards-reserved",
                ".other-inventory-card-reserved", "development-cards", "#other-player-reserved-card-template");

    // Update nobles
    updateCards(pInfo.nobleCards, pNode, ".other-inventory-noble-cards",
                ".noble-card", "nobles", "#noble-card-template");

    // Update reserved nobles
    updateCards(pInfo.reservedNobles, pNode, ".other-inventory-reserved-noble-cards",
                ".noble-card", "nobles", "#noble-card-template");

    // update prestige points
    pNode.querySelector(".other-prestige-point-container > span").textContent = pInfo.prestigePoints;

};

const updateNoblesBoard = async (cards) => {
    const selector = ".board-nobles .noble-card";

    const serverCardIds = cards.map(c => c.id);
    const currentCardIds = [...document.querySelectorAll(`${selector}[card-id]`)].map(elm => elm.getAttribute("card-id"));

    // cards that exist on board but not server side, must remove
    const outdatedCardIds = currentCardIds.filter(x => !serverCardIds.includes(x));
    outdatedCardIds.forEach(cid => {
        const oldElm = document.querySelector(`${selector}[card-id="${cid}"]`);
        oldElm.removeAttribute("card-id");
        oldElm.querySelector("img").removeAttribute("src");
    });

    const missingCards = cards.filter(c => !currentCardIds.includes(c.id));
    missingCards.forEach(card => {
        // select empty ones to fill
        const emptyCardElm = document.querySelector(`${selector}:not([card-id])`);
        emptyCardElm.setAttribute("card-id", card.id);
        emptyCardElm.querySelector("img").setAttribute("src", `/images/nobles/${card.id}.jpg`);
        emptyCardElm.setAttribute("had-card", "true");
    });
};

// last state that rendered successfully, and the state being (or last) rendered
let renderedState = null;
let currentState = null;
// hash of the state already written to the history panel
let historyHash = null;

// array for other updates that can be done (extensions)
const furtherUpdates = [];

/**
 * Render a game state from the Game Service. Throwing leaves the poll's
 * stored hash unchanged, so the same state is fetched and rendered again.
 *
 * @param {object} data parsed game state
 * @param {string} hash MD5 of the exact response body
 */
const renderGameState = (data, hash) => {
    currentState = data;
    if(historyHash !== hash) {
        writeUpdate(renderedState, data);
        historyHash = hash;
    }

    // tokens update
    const tokenMap = data.tokens;
    updateTokensCount("#board .board-tokens", tokenMap);

    const curUsername = SETTINGS.getUsername();

    const playersData = data.players;
    let amPlaying = false;
    playersData.forEach((pInfo) => {
        if(pInfo.name === curUsername) {
            updateMainPlayerInfo(pInfo);
            amPlaying = true;
        } else {
            updateOtherPlayerInfo(pInfo);
        }
    });
    const playerInv = document.querySelector("#player-inventory");
    if(!amPlaying) {
        // you are spectating, hide the player inventory on the left
        playerInv.classList.add("hide");
    } else if(playerInv.classList.contains("hide")) {
        playerInv.classList.remove("hide");
    }

    updateNoblesBoard((data.nobleDeck && data.nobleDeck.visibleCards) || []);
    updateTierRow(".board-cards-row.board-cards-level1", data.tier1Deck, data.tier1OrientDeck);
    updateTierRow(".board-cards-row.board-cards-level2", data.tier2Deck, data.tier2OrientDeck);
    updateTierRow(".board-cards-row.board-cards-level3", data.tier3Deck, data.tier3OrientDeck);

    furtherUpdates.forEach((func) => func(data));

    const currentPlayer = data.players[data.turnCounter];
    updateTurnStatus(data);
    if(data.gameOver) {
        verifyNoModals();
        initGameOver(data, (name) => playerAlias(currentLobbySession, name));
        showNextModal("#gameover-modal");
    } else if(currentPlayer && currentPlayer.name === curUsername) {
        // it's your turn
        if(!performFollowUpAction(data)) {
            startTurn();
        }
    } else {
        verifyNoModals();
    }

    renderedState = data;
    setBoardTestHooks(data, hash);
};

/**
 * End-to-end test hooks, set on document.body after every successful render.
 * Stable contract (see docs/client-architecture.md):
 * - data-splendor-ready="1" once the board has rendered a state;
 * - data-splendor-turn: username of the player whose turn it is, "" when the
 *   game is over or no current player is known;
 * - data-splendor-state-hash: MD5 of the last rendered state (the exact GS body);
 * - data-splendor-game-over="1" when the game is over (absent otherwise).
 */
const setBoardTestHooks = (data, hash) => {
    const hooks = document.body.dataset;
    const currentPlayer = data.players[data.turnCounter];
    hooks.splendorTurn = !data.gameOver && currentPlayer ? currentPlayer.name : "";
    hooks.splendorStateHash = hash;
    if(data.gameOver) {
        hooks.splendorGameOver = "1";
    } else {
        delete hooks.splendorGameOver;
    }
    hooks.splendorReady = "1";
};

// Errors worth a toast (not connection blips, which show the indicator).
let lastShownPollError = null;
const showPollErrorOnce = (message) => {
    if(message === lastShownPollError) return;
    lastShownPollError = message;
    showError(message);
};

/**
 * Lobby Service poll on this session, for aliases, observers and
 * moderators. The LS deletes the session when the game ends; then it stops.
 * It does not let the LS hold requests (see LS_HOLDS_REQUESTS) and checks
 * every 10 s instead; this board's own moderation actions refresh at once.
 */
const lobbySessionPoll = createLongPoll({
    name: "board-lobby-session",
    indicator: false,
    hold: LS_HOLDS_REQUESTS,
    intervalMs: 10000,
    // badges and aliases can wait until the tab is visible again
    pauseWhenHidden: true,
    url: (hash) => {
        const url = new URL(`${SETTINGS.getLS_API()}/api/sessions/${getSessionId()}`);
        url.search = new URLSearchParams({ hash }).toString();
        return url;
    },
    onUpdate: (data) => {
        if(!isLobbySession(data)) throw new Error("Lobby session reply has an unexpected shape.");
        currentLobbySession = data;
        refreshGameModerationChrome();
    },
    onGone: () => true,
});

let boardBooted = false;
/**
 * Runs before every game-state request. The identity check is cached by
 * SETTINGS, so after the first success this costs nothing. The first lobby
 * session fetch happens once, before the first render, so that player
 * aliases are known when the board first draws.
 */
const beforeGameStateRequest = async () => {
    await SETTINGS.verifyCredentials();
    if(boardBooted) return;
    boardBooted = true;
    if(SETTINGS.migrateLinkRejected()) {
        showError("This migrate link is no longer valid, so the board uses your own account.", 8000);
    }
    const { session, hash } = await fetchLobbySession(getSessionId());
    currentLobbySession = session;
    if(hash) lobbySessionPoll.setHash(hash);
    lobbySessionPoll.start();
};

/**
 * Game Service long-poll on the game state.
 */
const gameStatePoll = createLongPoll({
    name: "board",
    url: (hash) => {
        const url = new URL(`${SETTINGS.getGS_API()}/api/sessions/${getSessionId()}`);
        url.search = new URLSearchParams({ hash }).toString();
        return url;
    },
    beforeRequest: beforeGameStateRequest,
    onUpdate: (data, text, hash) => {
        renderGameState(data, hash);
        lastShownPollError = null;
    },
    onError: (err, info) => {
        // A 400 means the GS does not know this session (for example after a
        // GS restart). Tell the user once; keep retrying slowly in case it returns.
        if(info.kind === "client") showPollErrorOnce(err.message || "This game could not be loaded.");
        if(info.kind === "render") showPollErrorOnce("The board could not be updated: " + (err.message || err));
    },
});

/**
 * Add an updater to the main update executor.
 * The added function should take in as an argument the data from the game server.
 * 
 * @param {Function} func 
 */
export const addUpdater = (func) => {
    furtherUpdates.push(func);
}

document.addEventListener("DOMContentLoaded", () => {
    gameStatePoll.start();
});
