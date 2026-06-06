import { SETTINGS } from "./settings";
import { transition } from "./titleScreen";

document.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayName = document.querySelector(".txt-field input[name='uname']").value.trim() || "Player";
    localStorage.setItem("displayName", displayName);
    await SETTINGS.verifyCredentials();
    transition("/lobby/");
});
