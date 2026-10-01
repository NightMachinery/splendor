import { SETTINGS, boardPathForVersion, createLongPoll } from "./settings.js";
import { checkForGameSaves } from "./lobby-saves.js";
import { getUserDetail } from "./user-settings.js";
import { showError } from "./notify.js";
import { renderProfileAvatar } from "./avatar.js";
import {
    playerAlias, isObserver, isMod,
    renderPlayerBadges, renderModerationActions
} from "./moderation-ui.js";

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
 * @param {HTMLElement} elm button (disabled while the request runs)
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
    }).finally(() => elm.disabled = false);
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
    // set user color
    getUserDetail().then((data) => {
        if(data) {
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
        }
    }).catch((err) => showError(err.toString()));

    sessionTabBtn.onclick = () => showSessionTab();
    loadgameTabBtn.onclick = () => showLoadGameTab();

    // PLAYER GREETING
    document.getElementById("player-greeting").textContent = greetUser();

    function greetUser() {
        var welcome = "Hello, " + SETTINGS.getUsername() +"!";
        return welcome;
    }
    
    /**
     * Create a session with the specified version of Splendor.
     *
     * @param {string} gameVersion version of splendor
     */
    function createSession(gameVersion) {
        const createBtn = document.querySelector(".create-session-btn");
        createBtn.disabled = true;

        createNewSession(gameVersion)
            .catch((err) => showError(err.toString()))
            .finally(() => createBtn.disabled = false);
    }

    // SPECIFY GAME VERSION
    document.querySelectorAll(".game-options li").forEach(option => {
        option.addEventListener("click", () => {
            const version = "splendor_" + option.getAttribute("version");
            createSession(version);
        });
    });

    const sessionIdOf = (elm) => elm.closest("tr[session-id]").getAttribute("session-id");

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
                buildMigrateLink: (migrate) => `${window.location.origin}${boardPathForVersion(version)}?sessionId=${sessionId}&migrate=${encodeURIComponent(migrate)}`
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

        const setAttributes = (ses, node) => {
            const sesPlayers = ses.players;
            const activePlayers = sesPlayers.filter(p => !isObserver(ses, p));

            if(sesPlayers.includes(username)) {
                node.setAttribute("joined", "true");
            } else {
                node.removeAttribute("joined");
            }

            if(isMod(ses, username)) {
                node.setAttribute("mod", "true");
            } else {
                node.removeAttribute("mod");
            }

            if(activePlayers.length >= ses.gameParameters.maxSessionPlayers) {
                node.setAttribute("full", "true");
            } else {
                node.removeAttribute("full");
            }

            if(ses.creator === username) {
                node.setAttribute("created", "true");
            } else {
                node.removeAttribute("created");
            }

            // if regular game and has enough players
            const regGameCan = ses.savegameid === "" && activePlayers.length > 1 && !ses.launched;
            // if save and equals players
            const saveCan = ses.savegameid !== "" && !ses.launched
                            && ses.gameParameters.maxSessionPlayers === activePlayers.length;
            if(ses.creator === username && (regGameCan || saveCan)) {
                node.setAttribute("launchable", "true");
            } else {
                node.removeAttribute("launchable");
            }

            if(ses.launched) {
                node.setAttribute("started", "true");
            } else {
                node.removeAttribute("started");
            }
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

            setAttributes(ses, trNode);

            // assign button events
            const delBtn = tempNode.querySelector(".del-btn.ses-btn");
            const leaveBtn = tempNode.querySelector(".leave-btn.ses-btn");
            const joinBtn = tempNode.querySelector(".join-btn.ses-btn");
            const launchBtn = tempNode.querySelector(".launch-btn.ses-btn");
            const playBtn = tempNode.querySelector(".play-btn.ses-btn");
            const spectateBtn = tempNode.querySelector(".spectate-btn.ses-btn");
            delBtn.onclick = () => { deleteSession(delBtn); };
            leaveBtn.onclick = () => { leaveSession(leaveBtn); };
            joinBtn.onclick = () => { joinSession(joinBtn); };
            launchBtn.onclick = () => { launchSession(launchBtn); };
            playBtn.onclick = () => playSession(playBtn, sesId, gameVer);
            spectateBtn.onclick = () => playSession(spectateBtn, sesId, gameVer);

            tbl.appendChild(tempNode);

            const focusIndex = toFocusList.indexOf(sesId);
            if(focusIndex !== -1) {
                setTimeout(() => {
                    const elm = tbl.querySelector(`tr[session-id="${sesId}"]`);
                    elm.scrollIntoView({ behavior: "smooth", block: "start" });
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
            setAttributes(ses, trNode);
            renderSessionPlayers(trNode, ses);
        });

    }

    // Long-poll the list of sessions (see createLongPoll in settings.js).
    const sessionsPoll = createLongPoll({
        name: "lobby",
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
        },
    });
    sessionsPoll.start();

});