import { SETTINGS, boardPathForVersion, createLongPoll, backoffDelay, LS_HOLDS_REQUESTS } from "./settings.js";
import { checkForGameSaves } from "./lobby-saves.js";
import { getUserDetail } from "./user-settings.js";
import { showError, showSuccess } from "./notify.js";
import { renderProfileAvatar } from "./avatar.js";
import { copyText } from "./clipboard.js";
import { readLobbyInvite, withLobbyInvite } from "./lobby-invite.js";
import {
    playerAlias, isObserver, isMod,
    renderPlayerBadges, renderModerationActions
} from "./moderation-ui.js";

// The session-list poll, created on DOMContentLoaded.
let sessionsPoll = null;

/**
 * Fetch the session list now instead of at the next poll, after this
 * page changed it (create, join, leave, launch, delete, moderation).
 */
const refreshSessionList = () => {
    if(sessionsPoll) sessionsPoll.wake();
};

/**
 * Creates a new session with the specified game version and save id.
 * @param {String} gameVersion game version
 * @param {String} save id (optional)
 * @returns {Promise<String>} session id
 */
export const createNewSession = async (gameVersion, saveId="") => {
    await SETTINGS.verifyCredentials();

    const postData = {
        "creator": SETTINGS.getUsername(),
        "game": gameVersion,
        "savegame": saveId
    };

    const url = new URL(`${SETTINGS.getLS_API()}/api/sessions`);
    url.search = new URLSearchParams({"access_token": SETTINGS.getAccessToken()}).toString();

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData)
    });

    const respText = await resp.text();
    if(!resp.ok) {
        if(resp.status === 401) SETTINGS.invalidateCredentials();
        throw new Error(respText || `Could not create the session (${resp.status}).`);
    }

    refreshSessionList();
    return respText;
};

/**
 * User-facing text for a failed lobby action.
 */
const actionErrorText = (label, err) => {
    if(err && err.transient) return `${label} failed: could not reach the server. Try again.`;
    return `${label} failed: ${err && err.message ? err.message : err}`;
};

/**
 * Run an authenticated Lobby Service request for a session button.
 * A 401 drops the cached identity check so the next action re-verifies.
 *
 * @param {HTMLButtonElement} elm button (disabled while the request runs)
 * @param {string} method HTTP method
 * @param {string} path path under the LS API, starting with /api/
 * @param {string} label action name for error messages
 */
const runSessionRequest = (elm, method, path, label) => {
    elm.disabled = true;
    SETTINGS.verifyCredentials().then(async () => {
        const url = new URL(`${SETTINGS.getLS_API()}${path}`);
        url.search = new URLSearchParams({"access_token": SETTINGS.getAccessToken()}).toString();
        const resp = await fetch(url, { method });
        if(!resp.ok) {
            if(resp.status === 401) SETTINGS.invalidateCredentials();
            const text = await resp.text().catch(() => "");
            showError(text || `${label} failed (${resp.status}).`);
        }
    }).catch((err) => {
        if(!(err && err.authRejected)) showError(actionErrorText(label, err));
    }).finally(() => {
        elm.disabled = false;
        refreshSessionList();
    });
};

const changeTab = (selectedElm, otherElm) => {
    if(otherElm.classList.contains("selected")) {
        otherElm.classList.remove("selected");
    }

    if(!selectedElm.classList.contains("selected")) {
        selectedElm.classList.add("selected");
    }
};

const sessionTabBtn = document.querySelector("#select-sessions");
const loadgameTabBtn = document.querySelector("#select-loadgame");
export const showSessionTab = () => {
    changeTab(sessionTabBtn, loadgameTabBtn);
    document.querySelector("main").setAttribute("selected", "sessions");
};

const showLoadGameTab = () => {
    changeTab(loadgameTabBtn, sessionTabBtn);
    document.querySelector("main").setAttribute("selected", "loadgame");
    checkForGameSaves();
};

// for focusing on a session
const toFocusList = [];

/**
 * Attempts to focus on session item if it's already availabe,
 * else it will wait until it gets added to the page.
 * @param {String} sesId session id
 */
export const focusSession = (sesId) => {
    const elm = document.querySelector(`.current-sessions-table tr[session-id="${sesId}"]`);
    if(!elm) {
        toFocusList.push(sesId);
    } else {
        elm.scrollIntoView({ behavior: "smooth", block: "start" });
    }
};


document.addEventListener("DOMContentLoaded", () => {
    const invitedSession = readLobbyInvite();
    let openedInvite = false;

    // set user color
    // Avatar and role. Retried with backoff, without toasts, while the
    // Lobby Service is unreachable (e.g. during a redeploy).
    let userDetailAttempts = 0;
    const loadUserDetail = () => {
        userDetailAttempts++;
        const retry = () => {
            if(userDetailAttempts < 12) setTimeout(loadUserDetail, backoffDelay(userDetailAttempts));
        };
        getUserDetail().then((data) => {
            if(!data) {
                retry();
                return;
            }
            renderProfileAvatar(document.querySelector(".profile-pic"), data);

            // show service / admin stuff
            if(data.role === "ROLE_ADMIN") {
                document.querySelector("body").classList.add("is-admin");
            } else if(data.role === "ROLE_SERVICE") {
                document.querySelector("body").classList.add("is-service");
            } else {
                document.querySelector("body").classList.remove("is-service");
                document.querySelector("body").classList.remove("is-admin");
            }
        }).catch((err) => {
            if(err && err.authRejected) return; // the login page is being shown
            if(err && (err.transient || err instanceof TypeError)) {
                retry();
                return;
            }
            showError(err.toString());
        });
    };
    loadUserDetail();

    sessionTabBtn.onclick = () => showSessionTab();
    loadgameTabBtn.onclick = () => showLoadGameTab();

    // PLAYER GREETING
    document.getElementById("player-greeting").textContent = greetUser();

    function greetUser() {
        var welcome = "Hello, " + SETTINGS.getUsername() +"!";
        return welcome;
    }
    
    const gamePicker = document.querySelector(".game-selection-dropdown");
    let creatingSession = false;
    gamePicker.querySelectorAll("button[data-version]").forEach(option => {
        option.addEventListener("click", async () => {
            if (creatingSession) return;
            creatingSession = true;
            gamePicker.open = false;
            gamePicker.querySelector("summary").focus();
            try {
                focusSession(await createNewSession("splendor_" + option.dataset.version));
            } catch (err) {
                if (!err?.authRejected) showError(actionErrorText("Creating the session", err));
            } finally {
                creatingSession = false;
            }
        });
    });

    const sessionIdOf = (elm) => elm.closest("tr[session-id]").getAttribute("session-id");

    const copyInvite = async (button) => {
        const link = new URL(withLobbyInvite("/lobby/", sessionIdOf(button)), window.location.origin).href;
        const input = button.closest("td").querySelector(".session-invite-url");
        if(await copyText(link).catch(() => false)) {
            input.hidden = true;
            showSuccess("Invite link copied.");
            return;
        }
        input.value = link;
        input.hidden = false;
        input.focus();
        input.select();
    };

    const joinSession = (elm) => {
        const sessionId = sessionIdOf(elm);
        runSessionRequest(elm, "PUT", `/api/sessions/${sessionId}/players/${SETTINGS.getUsername()}`, "Joining");
    };

    const leaveSession = (elm) => {
        const sessionId = sessionIdOf(elm);
        runSessionRequest(elm, "DELETE", `/api/sessions/${sessionId}/players/${SETTINGS.getUsername()}`, "Leaving");
    };

    const deleteSession = (elm) => {
        const sessionId = sessionIdOf(elm);
        runSessionRequest(elm, "DELETE", `/api/sessions/${sessionId}`, "Deleting");
    };

    const launchSession = (elm) => {
        const sessionId = sessionIdOf(elm);
        runSessionRequest(elm, "POST", `/api/sessions/${sessionId}`, "Launching");
    };


    const playSession = (elm, sesId, gameVer) => {
        let boardPath;
        try {
            boardPath = boardPathForVersion(gameVer);
        } catch(err) {
            showError(err.message);
            return;
        }
        elm.disabled = true;

        SETTINGS.verifyCredentials().then(() => {
            window.location.href = `${boardPath}?sessionId=${encodeURIComponent(sesId)}`;
        }).catch((err) => {
            if(!(err && err.authRejected)) showError(actionErrorText("Opening the game", err));
        }).finally(() => elm.disabled = false);
    };

    const renderSessionPlayers = (row, ses) => {
        const cell = row.querySelector(".session-players-info");
        const username = SETTINGS.getUsername();
        const sessionId = row.getAttribute("session-id");
        const version = row.getAttribute("version");
        const maxP = ses.gameParameters.maxSessionPlayers;
        const activeCount = ses.players.filter(p => !isObserver(ses, p)).length;
        const canSeeModeration = isMod(ses, username) || ses.players.includes(username);
        cell.innerHTML = "";

        const panel = document.createElement("details");
        panel.className = "session-player-panel";
        panel.open = canSeeModeration;
        cell.appendChild(panel);

        const summary = document.createElement("summary");
        summary.className = "session-player-summary";
        summary.innerHTML = `<span>Players / Moderation</span><strong>[${activeCount}/${maxP}]</strong>`;
        panel.appendChild(summary);

        const list = document.createElement("div");
        list.className = "session-player-list";
        panel.appendChild(list);

        ses.players.forEach((player) => {
            const self = player === username;
            const mod = isMod(ses, player);
            const observer = isObserver(ses, player);

            const item = document.createElement("div");
            item.className = "session-player-card";
            item.classList.toggle("self", self);
            item.classList.toggle("observer", observer);
            item.classList.toggle("moderator", mod);

            const meta = document.createElement("div");
            meta.className = "session-player-meta";
            const name = document.createElement("span");
            name.className = "session-player-name";
            name.textContent = playerAlias(ses, player);
            name.title = `Internal id: ${player}`;
            meta.appendChild(name);

            const badges = document.createElement("span");
            badges.className = "session-player-badges";
            renderPlayerBadges(badges, ses, player, "session-player-badge");
            meta.appendChild(badges);
            item.appendChild(meta);

            const actions = document.createElement("div");
            actions.className = "session-player-actions";
            renderModerationActions(actions, ses, sessionId, player, {
                buildMigrateLink: (migrate) => `${window.location.origin}${boardPathForVersion(version)}?sessionId=${sessionId}&migrate=${encodeURIComponent(migrate)}`,
                afterAction: refreshSessionList,
            });
            item.appendChild(actions);
            list.appendChild(item);
        });
    };

    function updateAvailableSessions(data) {
        // first remove any sessions that don't need to be shown anymore (if currently shown)
        const tableSel = ".current-sessions-table";
        const templateSel = "#available-session-template";

        const username = SETTINGS.getUsername();

        // map sessions
        const nowAvailableSesions = {};
        const nowAvailableSesIdList = [];
        for (const [sessionId, value] of Object.entries(data.sessions)) {
            nowAvailableSesions[sessionId] = value;
            nowAvailableSesIdList.push(sessionId);
        }

        // make list of all sessions already shown id
        const current = document.querySelectorAll(`${tableSel} tr:not(:first-child)`);
        const curSesIdList = [];
        current.forEach((elm) => {
            curSesIdList.push(elm.getAttribute("session-id"));
        });

        // calc difference of lists
        const toAddSesIdList = nowAvailableSesIdList.filter(x => !curSesIdList.includes(x));

        // remove session that are no longer there
        const toRemoveSesIdList = curSesIdList.filter(x => !nowAvailableSesIdList.includes(x));

        // Remove non available sessions
        toRemoveSesIdList.forEach((sesId) => {
            document.querySelector(`${tableSel} tr[session-id="${sesId}"]`).remove();
        });

        const updateSessionState = (ses, node) => {
            const host = ses.creator === username;
            const joined = ses.players.includes(username);
            const invited = node.getAttribute("session-id") === invitedSession;
            const activeCount = ses.players.filter(p => !isObserver(ses, p)).length;
            const capacity = ses.gameParameters.maxSessionPlayers;
            // A saved game needs every original seat filled. A new game can start with two.
            const restoring = ses.savegameid !== "";
            const minPlayers = restoring ? capacity : 2;
            const ready = restoring ? activeCount === capacity : activeCount >= minPlayers;

            node.toggleAttribute("joined", joined);
            node.toggleAttribute("mod", isMod(ses, username));
            node.toggleAttribute("full", activeCount >= capacity);
            node.toggleAttribute("created", host);
            node.toggleAttribute("launchable", host && ready && !ses.launched);
            node.toggleAttribute("started", ses.launched);
            node.toggleAttribute("data-invited", invited);

            let message = "";
            if(ses.launched) {
                if(joined || invited) message = "Game started.";
            } else if(host) {
                const needed = Math.max(1, minPlayers - activeCount);
                message = ready ? `Ready to start with ${activeCount} players.`
                    : `Waiting for ${needed} more ${needed === 1 ? "player" : "players"}.`;
            } else if(joined) {
                message = "Waiting for the host to start.";
            } else if(invited) {
                message = activeCount >= capacity ? "The invited session is full." : "Invited session";
            }

            const status = node.querySelector(".session-status");
            if(status.textContent !== message) status.textContent = message;
        };

        // Add available sessions
        const tbl = document.querySelector(tableSel);
        toAddSesIdList.forEach((sesId) => {
            const tempNode = document.querySelector(templateSel).content.cloneNode(true);
            const ses = nowAvailableSesions[sesId];
            const gameVer = ses.gameParameters.name.replace("splendor_", "");

            const trNode = tempNode.querySelector("tr");
            trNode.setAttribute("session-id", sesId);
            trNode.setAttribute("version", gameVer);
            if(ses.savegameid !== "") {
                trNode.setAttribute("save-id", ses.savegameid);
            }

            trNode.querySelector(".session-game-name").textContent = ses.gameParameters.displayName;
            trNode.querySelector(".session-creator-name").textContent = playerAlias(ses, ses.creator);
            trNode.querySelector(".session-creator-name").title = `Internal id: ${ses.creator}`;

            renderSessionPlayers(trNode, ses);

            updateSessionState(ses, trNode);

            // assign button events
            const delBtn = tempNode.querySelector(".del-btn.ses-btn");
            const leaveBtn = tempNode.querySelector(".leave-btn.ses-btn");
            const joinBtn = tempNode.querySelector(".join-btn.ses-btn");
            const launchBtn = tempNode.querySelector(".launch-btn.ses-btn");
            const playBtn = tempNode.querySelector(".play-btn.ses-btn");
            const spectateBtn = tempNode.querySelector(".spectate-btn.ses-btn");
            const inviteBtn = tempNode.querySelector(".copy-invite-btn.ses-btn");
            delBtn.onclick = () => { deleteSession(delBtn); };
            leaveBtn.onclick = () => { leaveSession(leaveBtn); };
            joinBtn.onclick = () => { joinSession(joinBtn); };
            launchBtn.onclick = () => { launchSession(launchBtn); };
            playBtn.onclick = () => playSession(playBtn, sesId, gameVer);
            spectateBtn.onclick = () => playSession(spectateBtn, sesId, gameVer);
            inviteBtn.onclick = () => copyInvite(inviteBtn);

            tbl.appendChild(tempNode);

            const focusIndex = toFocusList.indexOf(sesId);
            if(focusIndex !== -1) {
                setTimeout(() => {
                    const elm = tbl.querySelector(`tr[session-id="${sesId}"]`);
                    elm?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 100);

                // now remove
                toFocusList.splice(focusIndex, 1);
            }
        });


        // Must also check if player list changed
        const alreadyInListId = nowAvailableSesIdList.filter(x => curSesIdList.includes(x));
        alreadyInListId.forEach((sesId) => {
            const ses = nowAvailableSesions[sesId];
            const trNode = document.querySelector(`tr[session-id="${sesId}"]`);

            trNode.querySelector(".session-game-name").textContent = ses.gameParameters.displayName;
            trNode.querySelector(".session-creator-name").textContent = playerAlias(ses, ses.creator);
            trNode.querySelector(".session-creator-name").title = `Internal id: ${ses.creator}`;
            updateSessionState(ses, trNode);
            renderSessionPlayers(trNode, ses);
        });

    }

    // Poll the list of sessions (see createLongPoll in settings.js). It does
    // not let the LS hold requests (see LS_HOLDS_REQUESTS) and checks every
    // 3 s instead; this page's own actions refresh it at once.
    sessionsPoll = createLongPoll({
        name: "lobby",
        hold: LS_HOLDS_REQUESTS,
        intervalMs: 3000,
        // a hidden lobby catches up on visibilitychange
        pauseWhenHidden: true,
        url: (hash) => {
            const url = new URL(`${SETTINGS.getLS_API()}/api/sessions`);
            url.search = new URLSearchParams({ hash }).toString();
            return url;
        },
        beforeRequest: () => SETTINGS.verifyCredentials(),
        onUpdate: (data) => {
            if(!data || typeof data.sessions !== "object" || data.sessions === null) {
                throw new Error("Session list reply has an unexpected shape.");
            }
            updateAvailableSessions(data);
            if(invitedSession) {
                const row = document.querySelector(".current-sessions-table tr[data-invited]");
                document.querySelector(".invite-unavailable").hidden = !!row;
                if(row && !openedInvite) {
                    openedInvite = true;
                    row.tabIndex = -1;
                    row.focus({ preventScroll: true });
                    row.scrollIntoView({ block: "start" });
                }
            }
            // e2e test hook (stable contract): the session list has rendered once
            document.body.dataset.splendorLobbyReady = "1";
        },
    });
    sessionsPoll.start();

});
