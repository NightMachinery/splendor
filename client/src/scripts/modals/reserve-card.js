import { backButton, setupDevelopmentCardSelection, showNextModal } from "./modals.js";
import { reservationContext } from "../card-details.js";
import { performAction } from "../actions";
import { showError } from "../notify.js";
import { ERROR_COPY, mapServerError } from "../sp/errors.js";
import { buildReservePayload } from "../sp/rules-pay.js";

const selector = "#reserve-card-modal";
const modal = document.querySelector(selector);
const board = modal.querySelector(".modal-board-cards");
const status = modal.querySelector(".reserve-status");
const fieldset = modal.querySelector(".reserve-gold");
const choices = modal.querySelector(".reserve-gold-choices");
const confirm = modal.querySelector("#reserve-card-confirm-btn");
let sending = false;
let optionsKey = "";

function updateOptions(colours, reset = false) {
    const key = colours.join(",");
    if (!reset && optionsKey === key) return;
    const selected = reset ? null : choices.querySelector("input:checked")?.value;
    optionsKey = key;
    choices.replaceChildren(...colours.map((colour) => {
        const label = document.createElement("label");
        label.className = "reserve-gold-choice";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "reserve-return";
        input.value = colour;
        input.checked = colour === selected;
        if (colour !== "Gold") input.setAttribute("aria-label", `Return 1 ${colour.toLowerCase()}`);
        label.append(input, colour === "Gold" ? "Leave gold in bank" : colour);
        return label;
    }));
}

function refresh(reset = false) {
    const id = board.querySelector(".board-card-dev.selected")?.getAttribute("card-id");
    const { outcome, returns } = reservationContext(id);
    const needsReturn = !!id && outcome.ok && outcome.gold === "needs-return";
    updateOptions(needsReturn ? returns : [], reset);
    fieldset.hidden = !needsReturn;
    fieldset.disabled = sending;
    const token = needsReturn ? choices.querySelector("input:checked")?.value : undefined;
    const ready = !!id && outcome.ok && (!needsReturn || !!token);
    let message = "";
    if (!outcome.ok) message = outcome.reason;
    else if (id && outcome.gold === "bank-empty") message = "The bank has no gold. You can still reserve the card.";
    else if (id && !needsReturn) message = "You will take 1 gold from the bank.";
    if (status.textContent !== message) status.textContent = message;
    confirm.disabled = sending || !ready;
    confirm.textContent = sending ? "Reserving…" : "Reserve card";
    return confirm.disabled ? null : buildReservePayload(id, token);
}

export function refreshReserveCard() {
    if (modal.classList.contains("show")) refresh();
}

document.getElementById("reserve-btn").onclick = () => {
    const rows = document.querySelectorAll("#board .board-cards .board-cards-row");
    board.replaceChildren(...[...rows].map((row) => row.cloneNode(true)));
    setupDevelopmentCardSelection(selector, ".modal-board-cards .board-card-dev", () => refresh(true));
    refresh(true);
    showNextModal(selector);
};
modal.querySelector("#reserve-card-back-btn").onclick = backButton;
choices.addEventListener("change", () => refresh());
confirm.addEventListener("click", async () => {
    const payload = refresh();
    if (!payload) return;
    sending = true;
    refresh();
    try {
        const response = await performAction("RESERVE_CARD", () => payload);
        if (response.error) {
            const problem = mapServerError(response.message, response.status);
            showError(problem.code === "UNKNOWN" && problem.raw ? problem.raw : problem.copy);
        }
    } catch {
        showError(ERROR_COPY.NETWORK);
    } finally {
        sending = false;
        refreshReserveCard();
    }
});
