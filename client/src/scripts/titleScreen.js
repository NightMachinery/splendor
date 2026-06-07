import { SETTINGS } from "./settings.js";
const transition_el = document.querySelector(".transition");
const button_el = document.querySelectorAll(".title-login-button");

export function transition(newLink) {

    transition_el.classList.add("is-active");

    setTimeout(() => {
        window.location.pathname = newLink;
    }, 400);
}

window.addEventListener("load", () => {
    const onTitlePage = window.location.pathname === "/" || window.location.pathname === "/index.html";
    if(onTitlePage && !SETTINGS.hasLocalIdentity()) {
        transition("/login/");
        return;
    }

    for (let i = 0; i < button_el.length; i++) {
        const btn = button_el[i];

        if(SETTINGS.hasLocalIdentity()) {
            btn.textContent = "Continue";
        }
        btn.addEventListener("click", function() {
            transition(SETTINGS.hasLocalIdentity() ? "/lobby/" : "/login/");
        });
    }
});

window.onpageshow = () => {
    setTimeout(() => {
        transition_el.classList.remove("is-active");
    }, 400);
};