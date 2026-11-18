import { showNextModal, setupDevelopmentCardSelection, backButton } from "./modals.js";
import { openPurchasePayment } from "./purchase-payment.js";
import { performAction } from "../actions";
import { showError } from "../notify.js";

/**
 * Read the chosen tokens when taking or returning tokens.
 * @returns [{ token: count }]
 */
const getTokensList = (selector) => {
    const tokensCountNodes = document.querySelectorAll(selector);

    const tokens = {};

    tokensCountNodes.forEach(node => {
        const tokenType = node.getAttribute("jewel-color");
        const count = node.parentNode.count;

        tokens[tokenType] = count;
    });

    return tokens;
};

const setBoardTokens = (modal) => {
    const boardNode = document.querySelector("#board .board-tokens");
    const modalNode = document.querySelector(modal);
    modalNode.querySelector(".red-token > span").textContent = boardNode.querySelector(".red-token > span").textContent;
    modalNode.querySelector(".blue-token > span").textContent = boardNode.querySelector(".blue-token > span").textContent;
    modalNode.querySelector(".green-token > span").textContent = boardNode.querySelector(".green-token > span").textContent;
    modalNode.querySelector(".white-token > span").textContent = boardNode.querySelector(".white-token > span").textContent;
    modalNode.querySelector(".brown-token > span").textContent = boardNode.querySelector(".brown-token > span").textContent;
    modalNode.querySelector(".gold-token > span").textContent = boardNode.querySelector(".gold-token > span").textContent;
};


// -----------------------------------------------------------------------------------------
// Setup take token & put back token
const getTokensBtn = document.getElementById("get-tokens-btn");
getTokensBtn.onclick = () => {
    takeTokens();
    showNextModal("#take-token-modal");
};
document.querySelectorAll(".take-token-back-btn").forEach(elm => elm.onclick = backButton);
document.querySelectorAll(".put-back-token-back-btn").forEach(elm => elm.onclick = backButton);

const takeTokens = () => {
    // clear previous numbers
    document.querySelectorAll("#take-token-modal board-token").forEach(elm => {
        elm.setCount(0);
    });

    // set min and max for counters, TODO: set max and min values to what tokens the player has
    document.querySelectorAll("#take-token-modal board-token-counter").forEach(elm => {
        elm.setMax(10);
    });

    setBoardTokens("#take-token-modal");

    document.querySelector("#take-token-modal #take-token-confirm-btn").onclick = () => {
        putBackTokens();
        showNextModal("#put-back-token-modal");
    };
};

const putBackTokens = () => {
    const confirmBtn = document.querySelector("#put-back-token-modal .put-back-token-confirm-btn");

    // clear previous numbers
    document.querySelectorAll("#put-back-token-modal board-token").forEach(elm => {
        elm.setCount(0);
    });

    // set min and max for counters, TODO: set max and min values to what tokens the player has
    document.querySelectorAll("#put-back-token-modal board-token-counter").forEach(elm => {
        elm.setMax(10);
    });

    setBoardTokens("#put-back-token-modal");

    confirmBtn.onclick = () => {
        confirmBtn.disabled = true;

        const dataCallback = () => {
            return {
                "takeTokens": getTokensList("#take-token-modal board-token-counter board-token .board-token"),
                "putBackTokens": getTokensList("#put-back-token-modal board-token-counter board-token .board-token")
            };
        };

        performAction("TAKE_TOKEN", dataCallback)
            .then((resp) => {
                if(resp.error) {
                    showError(resp.message);
                }
            }).catch((err) => {
                showError(err.toString());
            }).finally(() =>  confirmBtn.disabled = false);
    };
};


// -----------------------------------------------------------------------------------------
// Set up card purchasing
const purchaseBtn = document.getElementById("purchase-btn");
purchaseBtn.onclick = () => {
    // load the purchase items
    showPurchasableDevCards();
    showNextModal("#buy-card-modal");
};
document.querySelectorAll(".buy-card-back-btn, #purchase-confirm-back-btn").forEach(elm => elm.onclick = backButton);

const showPurchasableDevCards = () => {
    // show reserved cards (from player inv, maybe should pass in data from server instead?)
    const reservedCardNodes = [];
    const reservedCards = document.querySelectorAll("#player-inventory .player-inventory-reservedcards .player-inventory-card-reserved");
    reservedCards.forEach((elm) => {
        const cid = elm.getAttribute("card-id");
        const node = document.querySelector("#board-card-dev-template").content.cloneNode(true);
        const div = node.querySelector("div");
        const imgUrl = `/images/development-cards/${cid}.jpg`;

        div.setAttribute("card-id", cid);
        div.querySelector("img").setAttribute("src", imgUrl);

        // add to inv
        reservedCardNodes.push(node);
    });
    document.querySelector("#buy-card-modal .reserved-cards").replaceChildren(...reservedCardNodes);

    // literally just duplicate them from the board

    const cardRows = document.querySelectorAll("#board .board-cards .board-cards-row");

    // clear if already has
    const modalCardRows = document.querySelector("#buy-card-board .modal-board-cards");
    modalCardRows.innerHTML = "";

    cardRows.forEach((elm) => {
        const cNode = elm.cloneNode(true);
        modalCardRows.appendChild(cNode);
    });

    const cardsSelectionSelector = "#buy-card-modal .board-card-dev";

    setupDevelopmentCardSelection("#buy-card-modal", ".board-card-dev");

    document.querySelector("#buy-card-modal #buy-card-confirm-btn").onclick = () => {
        const selectedCard = document.querySelector(`${cardsSelectionSelector}.selected`);
        if(!selectedCard) {
            // no card has been selected, error
            showError("You have not selected a card to purchase!");
            return;
        }

        openPurchasePayment(selectedCard.getAttribute("card-id"));
        showNextModal("#dev-card-payment-modal");
    };
};

// -----------------------------------------------------------------------------------------
// Set up reserving cards
const reserveBtn = document.getElementById("reserve-btn");
reserveBtn.onclick = () => {
    // load the purchase items
    showReservableDevCards();
    showNextModal("#reserve-card-modal");
};
document.querySelectorAll(".reserve-card-back-btn").forEach(elm => elm.onclick = backButton);

const showReservableDevCards = () => {

    const confirmBtn = document.querySelector("#reserve-card-modal .reserve-card-confirm-btn");

    // literally just duplicate them from the board
    const cardRows = document.querySelectorAll("#board .board-cards .board-cards-row");

    // clear if already has
    const modalCardRows = document.querySelector("#reserve-card-board .modal-board-cards");
    modalCardRows.innerHTML = "";

    cardRows.forEach((elm) => {
        const cNode = elm.cloneNode(true);
        modalCardRows.appendChild(cNode);
    });

    const cardsSelectionSelector = "#reserve-card-modal .modal-board-cards .board-card-dev";

    setupDevelopmentCardSelection("#reserve-card-modal", ".modal-board-cards .board-card-dev");

    confirmBtn.onclick = () => {
        confirmBtn.disabled = true;

        const selectedCard = document.querySelector(`${cardsSelectionSelector}.selected`);
        if(!selectedCard) {
            // no card has been selected, error
            showError("You have not selected a card to reserve!");
            confirmBtn.disabled = false;
            return;
        }

        const dataCallback = () => {
            return { "cardId": selectedCard.getAttribute("card-id") };
        };

        performAction("RESERVE_CARD", dataCallback)
            .then((resp) => {
                if(resp.error) {
                    showError(resp.message);
                }
            }).catch((err) => {
                showError(err.toString());
            }).finally(() =>  confirmBtn.disabled = false);
    };
};
