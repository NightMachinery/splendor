import { SETTINGS } from "./settings";
import { transition } from "./titleScreen";
import { showError } from "./notify.js";
import { readLobbyInvite, withLobbyInvite } from "./lobby-invite.js";

const invitedSession = readLobbyInvite();
const lobbyPath = withLobbyInvite("/lobby/", invitedSession);

document.addEventListener("DOMContentLoaded", () => {
    if(SETTINGS.hasLocalIdentity()) {
        transition(invitedSession ? lobbyPath : "/");
    }
});

const form = document.querySelector("form");
form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector("button[type='submit'], .login-button");
    if(submitBtn) {
        if(submitBtn.disabled) return; // a login request is already running
        submitBtn.disabled = true;
    }
    const displayName = document.querySelector(".txt-field input[name='uname']").value.trim() || "Player";
    try {
        // the display name is stored only once the Lobby Service accepted it
        await SETTINGS.verifyCredentials({ allowCreate: true, displayName });
        transition(lobbyPath);
    } catch(err) {
        if(err && err.transient) {
            showError("Could not reach the server. Check your connection and try again.");
        } else {
            showError(err && err.message ? err.message : String(err));
        }
    } finally {
        if(submitBtn) submitBtn.disabled = false;
    }
});
