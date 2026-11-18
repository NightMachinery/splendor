import { purchaseContext, showCardReadout } from "../card-details.js";
import { performAction } from "../actions";
import { showError } from "../notify.js";
import { ERROR_COPY, mapServerError } from "../sp/errors.js";
import { amount } from "../sp/rules-common.js";
import { autoPayment, buildBuyPayload, checkPayment, satchelBlocked, stillOwed } from "../sp/rules-pay.js";

const modal = document.getElementById("dev-card-payment-modal");
const counters = [...modal.querySelectorAll("board-token-counter")].map((element) => {
    const colour = element.getAttribute("color");
    return { element, colour: colour[0].toUpperCase() + colour.slice(1) };
});
const fieldset = modal.querySelector("fieldset");
const resetButton = modal.querySelector("[data-reset-payment]");
const buyButton = modal.querySelector("#purchase-confirm-btn");
const summary = modal.querySelector("[data-payment-summary]");
const discard = modal.querySelector("[data-payment-discard]");
const list = new Intl.ListFormat("en");
let purchase;

function describeDiscard(payment, sacrifice) {
    if (payment.goldCardsToDiscard > 0) {
        const count = payment.goldCardsToDiscard;
        return `This will discard ${count} double-gold card${count === 1 ? "" : "s"}.`;
    }
    if (!sacrifice?.colour) return "";
    const count = sacrifice.cards.length;
    if (!count) return `This will discard cards that give ${sacrifice.colour.toLowerCase()} bonuses.`;
    const points = sacrifice.pointsLost;
    const loss = points ? ` and lose ${points} prestige point${points === 1 ? "" : "s"}` : "";
    return `You will discard ${count} ${sacrifice.colour.toLowerCase()} bonus card${count === 1 ? "" : "s"}${loss}.`;
}

function updatePayment({ applySuggestion = false } = {}) {
    const { card, player } = purchaseContext(purchase.cardId);
    const suggestion = autoPayment(card, player);
    const owed = stillOwed(card, player);
    const tokens = {};

    for (const { element, colour } of counters) {
        const held = amount(player?.tokens, colour);
        const limit = !card || card.costType === "Bonus" ? 0
            : colour === "Gold" ? held : Math.min(held, owed[colour]);
        const count = applySuggestion ? suggestion.tokens[colour] : element.querySelector("board-token").count;
        element.setMax(limit);
        tokens[colour] = Math.min(count, limit);
        element.setCount(tokens[colour]);
    }

    const payment = checkPayment(card, player, tokens);
    const blockedSatchel = satchelBlocked(card, player);
    const ready = !!card && !!player && !blockedSatchel && payment.ok;
    const spending = Object.entries(tokens).filter(([, count]) => count).map(([colour, count]) => `${count} ${colour}`);
    let message = spending.length ? `Pay ${list.format(spending)}.` : "No tokens needed.";
    if (!card) message = ERROR_COPY.CARD_GONE;
    else if (!player) message = ERROR_COPY.NOT_SEATED;
    else if (blockedSatchel) message = ERROR_COPY.SATCHEL_NEEDS_GEM_CARD;
    else if (!payment.ok) message = ERROR_COPY[payment.code] ?? "Adjust the tokens to cover the exact cost.";

    const warning = ready ? describeDiscard(payment, suggestion.sacrifice) : "";
    if (summary.textContent !== message) summary.textContent = message;
    if (discard.textContent !== warning) discard.textContent = warning;
    discard.hidden = !warning;

    fieldset.disabled = purchase.sending || !card || !player || blockedSatchel;
    fieldset.hidden = card?.costType === "Bonus";
    resetButton.hidden = !suggestion.ok || card?.costType === "Bonus";
    resetButton.disabled = purchase.sending || counters.every(({ colour }) => tokens[colour] === suggestion.tokens[colour]);
    buyButton.disabled = purchase.sending || !ready;
    buyButton.textContent = purchase.sending ? "Buying…" : "Buy card";
    return buyButton.disabled ? null : buildBuyPayload(purchase.cardId, tokens);
}

export function openPurchasePayment(cardId) {
    purchase = { cardId, sending: false };
    modal.querySelector(".purchase-show-card img").src = `/images/development-cards/${encodeURIComponent(cardId)}.jpg`;
    showCardReadout(modal, cardId);
    updatePayment({ applySuggestion: true });
}

export function refreshPurchasePayment() {
    if (purchase && modal.classList.contains("show")) updatePayment();
}

// The counter handles the button at the target before this delegated handler.
fieldset.addEventListener("click", (event) => {
    if (event.target.closest(".quantity-button")) updatePayment();
});
resetButton.addEventListener("click", () => updatePayment({ applySuggestion: true }));
buyButton.addEventListener("click", async () => {
    const payload = updatePayment();
    if (!payload) return;
    const attempt = purchase;
    attempt.sending = true;
    updatePayment();
    try {
        const response = await performAction("BUY_CARD", () => payload);
        if (!response.error) return; // Wait for the accepted move to render.
        const problem = mapServerError(response.message, response.status);
        showError(problem.code === "UNKNOWN" && problem.raw ? problem.raw : problem.copy);
    } catch {
        showError(ERROR_COPY.NETWORK);
    }
    if (attempt === purchase) {
        attempt.sending = false;
        refreshPurchasePayment();
    }
});
