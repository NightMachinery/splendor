import { cardById, cardTags, isGem, isOrientCard, locateCard, resolvePlayer, tierOf } from "./sp/rules-common.js";
import { costRows } from "./sp/rules-pay.js";

let state;
let player;

const describeRewards = (card) => {
    const points = card.prestigePoints ?? 0;
    const bonus = card.bonus ?? 0;
    const summary = [`${points} prestige point${points === 1 ? "" : "s"}`];
    if (bonus > 0 && (isGem(card.tokenType) || card.tokenType === "Gold")) {
        summary.push(`${bonus} ${card.tokenType.toLowerCase()} bonus${bonus === 1 ? "" : "es"}`);
    }
    return summary.join(" · ");
};

const effects = {
    cascade: (card) => `Take a visible tier ${card.cascadeType === "Tier1" ? 1 : 2} card for free after acquiring this card.`,
    "reserve-noble": () => "Reserve a noble from the board when available. It can visit once you qualify.",
    satchel: (card) => card.tokenType === "Satchel"
        ? "Requires a gem bonus card you own. Choose one of your existing gem colours for the satchel."
        : "This satchel has been assigned a gem colour.",
    "double-gold": () => "Discard this card when you spend either of its gold bonuses.",
    sacrifice: () => "Pay by discarding cards with the required bonuses.",
};

function costLine(label, costs) {
    const line = document.createElement("div");
    line.className = "card-readout-line";
    const title = document.createElement("strong");
    title.textContent = label;
    line.append(title);
    if (costs.length === 0) line.append("None");
    for (const { colour, count } of costs) {
        const chip = document.createElement("span");
        chip.className = "card-readout-cost";
        chip.dataset.spColor = colour;
        chip.textContent = `${count} ${colour}`;
        line.append(chip);
    }
    return line;
}

function renderReadout(root, card) {
    root.replaceChildren();
    if (!card) return;

    const summary = document.createElement("strong");
    summary.textContent = describeRewards(card);
    root.append(summary);

    const rows = costRows(card, player);
    const bonusCost = card.costType === "Bonus";
    if (root.dataset.cardReadout === "cascade") {
        root.append("Free as a cascade choice.");
    } else {
        const label = bonusCost ? "Bonuses to discard" : "Printed purchase cost";
        root.append(costLine(label, rows.map(({ colour, cost }) => ({ colour, count: cost }))));
        if (!bonusCost && rows.some(({ cost, owed }) => cost !== owed)) {
            const owed = rows.filter((row) => row.owed > 0).map(({ colour, owed }) => ({ colour, count: owed }));
            root.append(costLine("After your gem bonuses", owed));
        }
    }

    const tags = cardTags(card).filter((tag) => tag !== "sacrifice" || root.dataset.cardReadout !== "cascade");
    if (tags.length) {
        const list = document.createElement("ul");
        list.className = "card-readout-effects";
        for (const tag of tags) {
            const item = document.createElement("li");
            item.textContent = effects[tag](card);
            list.append(item);
        }
        root.append(list);
    }
}

export function showCardReadout(modal, cardId) {
    const root = modal.querySelector("[data-card-readout]");
    if (cardId) root.dataset.cardId = cardId;
    else delete root.dataset.cardId;
    renderReadout(root, cardById(state, cardId));
}

export function setCardDetailsState(data, username) {
    state = data;
    player = resolvePlayer(data, username);
    const dialog = document.getElementById("card-inspector");
    if (dialog.open) {
        const shown = locateCard(data, dialog.querySelector("[data-card-readout]").dataset.cardId);
        if (data.gameOver || !shown || (shown.where !== "market" && shown.owner !== username)) dialog.close();
    }
    for (const root of document.querySelectorAll(".modal.show [data-card-readout][data-card-id], #card-inspector[open] [data-card-id]")) {
        renderReadout(root, cardById(state, root.dataset.cardId));
    }
}

function labelCard(element, card, verb) {
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    const tier = tierOf(card);
    const context = tier ? `tier ${tier} ` : "";
    element.setAttribute("aria-label", `${verb} ${context}${isOrientCard(card) ? "Orient " : ""}card, ${describeRewards(card)}`);
}

export function setCardInspectTarget(element, card) {
    if (!card) {
        for (const attr of ["data-card-inspect", "role", "tabindex", "aria-haspopup", "aria-label"]) element.removeAttribute(attr);
        return;
    }
    element.dataset.cardInspect = "";
    labelCard(element, card, "Inspect");
    element.setAttribute("aria-haspopup", "dialog");
}

export function labelCardChoice(element) {
    const card = cardById(state, element.getAttribute("card-id"));
    if (!card) return;
    element.removeAttribute("data-card-inspect");
    element.removeAttribute("aria-haspopup");
    element.setAttribute("aria-pressed", "false");
    labelCard(element, card, "Select");
}

function inspectCard(element) {
    const id = element.getAttribute("card-id");
    const card = cardById(state, id);
    if (!card) return;
    const dialog = document.getElementById("card-inspector");
    const tier = tierOf(card);
    const kind = isOrientCard(card) ? "Orient" : "development";
    dialog.querySelector("h2").textContent = tier ? `Tier ${tier} ${kind} card` : "Development card";
    dialog.querySelector("img").src = `/images/development-cards/${encodeURIComponent(id)}.jpg`;
    showCardReadout(dialog, id);
    dialog.showModal();
}

document.addEventListener("click", (event) => {
    const element = event.target instanceof Element && event.target.closest("[data-card-inspect]");
    if (element) inspectCard(element);
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof Element) || !event.target.matches("[data-card-inspect]")) return;
    event.preventDefault();
    if (!event.repeat) inspectCard(event.target);
});
