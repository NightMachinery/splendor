import { SETTINGS } from "./settings.js";
import { showError, showSuccess } from "./notify.js";
import { copyText } from "./clipboard.js";

export const MODERATION_ICONS = {
    copy: `<svg viewBox="0 0 24 24"><path d="M10 7a5 5 0 0 1 7 0l1 1a5 5 0 0 1-7 7l-1-1 2-2 1 1a2 2 0 0 0 3-3l-1-1a2 2 0 0 0-3 0L9 12a5 5 0 0 1 1-5Zm4 10a5 5 0 0 1-7 0l-1-1a5 5 0 0 1 7-7l1 1-2 2-1-1a2 2 0 0 0-3 3l1 1a2 2 0 0 0 3 0l3-3a5 5 0 0 1-1 5Z"/></svg>`,
    observe: `<svg viewBox="0 0 24 24"><path d="M12 5c5 0 9 5 10 7-1 2-5 7-10 7s-9-5-10-7c1-2 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7-11-7Z"/></svg>`,
    shield: `<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5l-8-3Zm1 5v4h4v2h-4v4h-2v-4H7v-2h4V7h2Z"/></svg>`,
    unshield: `<svg viewBox="0 0 24 24"><path d="m3 4.3 1.3-1.3 17 17-1.3 1.3-3.1-3.1A14 14 0 0 1 12 22c-5-2-8-6-8-11V6.3L3 4.3ZM12 2l8 3v6c0 1.7-.3 3.3-1 4.7L6.6 3.3 12 2Z"/></svg>`
};

export const playerAlias = (session, player) => (session?.displayNames || {})[player] || player;
export const isObserver = (session, player) => (session?.observers || []).includes(player);
export const isMod = (session, player) => !!session && (session.creator === player || (session.mods || []).includes(player));
export const isTempMod = (session, player) => (session?.tempMods || []).includes(player);
export const canModerate = (session, actor) => isMod(session, actor);
export const canCopyMigrateLink = (session, actor, player) => actor === player || canModerate(session, actor);
export const canToggleObserver = (session, actor, player) => actor === player || canModerate(session, actor);
export const canTogglePlayerMod = (session, actor, player) => {
    const playerIsMod = isMod(session, player);
    return canModerate(session, actor)
        && player !== session?.creator
        && (!playerIsMod || session?.creator === actor);
};

export const setButtonBusy = (button, busy) => {
    if(!button) return;
    button.disabled = busy;
    button.classList.toggle("busy", busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
};

export const makeBadge = (text, className = "player-badge") => {
    const badge = document.createElement("span");
    badge.className = `${className} ${text.replace(/\s+/g, "-")}`;
    badge.textContent = text;
    return badge;
};

export const makeIconButton = (label, icon, onClick, extraClass = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `player-action-btn ${extraClass}`.trim();
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    button.onclick = onClick;
    return button;
};

export const postModerationAction = async (button, endpoint, params, successMessage) => {
    const url = new URL(`${SETTINGS.getLS_API()}${endpoint}`);
    url.search = new URLSearchParams({ "access_token": SETTINGS.getAccessToken(), ...params }).toString();
    setButtonBusy(button, true);
    try {
        const resp = await fetch(url, { method: "POST" });
        if(!resp.ok) {
            showError(await resp.text());
            return false;
        }
        if(successMessage) showSuccess(successMessage);
        return true;
    } catch(err) {
        showError(err.toString());
        return false;
    } finally {
        setButtonBusy(button, false);
    }
};

export const copyMigrateLink = async (button, session, sessionId, player, buildLink) => {
    const url = new URL(`${SETTINGS.getLS_API()}/api/sessions/${sessionId}/players/${player}/migrate-token`);
    url.search = new URLSearchParams({ "access_token": SETTINGS.getAccessToken() }).toString();
    setButtonBusy(button, true);
    try {
        const resp = await fetch(url, { method: "POST" });
        if(!resp.ok) {
            showError(await resp.text());
            return false;
        }
        const migrate = await resp.text();
        const link = buildLink(migrate);
        if(!await copyText(link)) {
            showError("Could not copy the migrate link automatically. Please copy it from the address bar after opening it.");
            return false;
        }
        showSuccess(`Copied migrate link for ${playerAlias(session, player)}.`);
        return true;
    } catch(err) {
        showError(err.toString());
        return false;
    } finally {
        setButtonBusy(button, false);
    }
};

export const renderPlayerBadges = (container, session, player, badgeClass = "player-badge") => {
    if(!container) return;
    container.innerHTML = "";
    if(!session) return;
    if(player === SETTINGS.getUsername()) container.appendChild(makeBadge("you", badgeClass));
    if(player === session.creator) container.appendChild(makeBadge("owner", badgeClass));
    else if(isMod(session, player)) container.appendChild(makeBadge(isTempMod(session, player) ? "temp mod" : "mod", badgeClass));
    if(isObserver(session, player)) container.appendChild(makeBadge("observer", badgeClass));
};

export const renderModerationActions = (container, session, sessionId, player, options = {}) => {
    if(!container) return;
    container.innerHTML = "";
    if(!session) return;
    const username = SETTINGS.getUsername();
    const alias = playerAlias(session, player);
    const observer = isObserver(session, player);
    const mod = isMod(session, player);
    const buildMigrateLink = options.buildMigrateLink || ((migrate) => `${window.location.origin}${window.location.pathname}?sessionId=${sessionId}&migrate=${encodeURIComponent(migrate)}`);
    const afterAction = options.afterAction || (() => {});

    if(canCopyMigrateLink(session, username, player)) {
        container.appendChild(makeIconButton(`Copy migrate link for ${alias}`, MODERATION_ICONS.copy,
            async (e) => {
                const ok = await copyMigrateLink(e.currentTarget, session, sessionId, player, buildMigrateLink);
                if(ok) afterAction();
            }));
    }
    if(canToggleObserver(session, username, player) && observer) {
        container.appendChild(makeIconButton(`Join ${alias} back as player`, MODERATION_ICONS.play,
            async (e) => {
                const ok = await postModerationAction(e.currentTarget, `/api/sessions/${sessionId}/players/${player}/observer`, { observer: false }, `${alias} rejoined as a player.`);
                if(ok) afterAction();
            }, "joinback"));
    } else if(canModerate(session, username) && !observer) {
        container.appendChild(makeIconButton(`Make ${alias} an observer`, MODERATION_ICONS.observe,
            async (e) => {
                const ok = await postModerationAction(e.currentTarget, `/api/sessions/${sessionId}/players/${player}/observer`, { observer: true }, `${alias} is now an observer.`);
                if(ok) afterAction();
            }, "observe"));
    }
    if(canTogglePlayerMod(session, username, player)) {
        container.appendChild(makeIconButton(mod ? `Demote ${alias}` : `Promote ${alias}`,
            mod ? MODERATION_ICONS.unshield : MODERATION_ICONS.shield,
            async (e) => {
                const ok = await postModerationAction(e.currentTarget, `/api/sessions/${sessionId}/players/${player}/mod`, { mod: !mod }, mod ? `${alias} is no longer a moderator.` : `${alias} is now a moderator.`);
                if(ok) afterAction();
            }, "modtoggle"));
    }
};
