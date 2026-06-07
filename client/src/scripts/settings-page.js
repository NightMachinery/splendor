import { SETTINGS } from "./settings.js";
import { showError } from "./notify";
import { updateUserData, getUserDetail } from "./user-settings.js";
import { renderProfileAvatar } from "./avatar.js";

const setUpdateColour = (name, container) => {
    const updateBtn = container.querySelector("button");
    updateBtn.addEventListener("click", () => {
        updateBtn.disabled = true;
        const newColor = (container.querySelector("input").value + "").substring(1).toUpperCase();
        console.log(`Requesting to change ${name}'s color to ${newColor}`);
        updateUserData({
            endpoint: `/api/users/${name}/colour`,
            bodyData: { colour: newColor.replace("#", "") },
            method: "POST",
            loadMessage: `Updating colour for ${name}...`,
            successMessage: `Successfully updated colour for ${name}!`
        }).then((success) => {
            if(success && name === SETTINGS.getUsername()) {
                document.querySelector(".your-colour input[type='color']").value = `#${newColor}`;
            }
        }).finally(() => updateBtn.disabled = false);
    });
};

const setDeleteUser = (name, deleteBtn) => {
    deleteBtn.addEventListener("click", () => {
        deleteBtn.disabled = true;
        console.log(`Requesting to delete user ${name}`);
        updateUserData({
            endpoint: `/api/users/${name}`,
            method: "DELETE",
            loadMessage: `Deleting user ${name}...`,
            successMessage: `Successfully deleted ${name}!`
        }).then((resp) => { 
            if(resp) {
                SETTINGS.clearLocalIdentity();
                SETTINGS.goToLogin();
            }
        }).finally(() => deleteBtn.disabled = false);
    });
};

const updateUserInfo = async () => {
    const data = await getUserDetail();
    if(data) {
        renderProfileAvatar(document.querySelector(".profile-pic"), data);
        document.querySelector(".your-colour input[type='color']").value = `#${data.preferredColour}`;

        const role = data.role.replace("ROLE_", "").toLowerCase();
        document.querySelector(".your-role").textContent = role.charAt(0).toUpperCase() + role.slice(1);

        const name = data.name;
        document.querySelector(".your-username").textContent = name;
        setUpdateColour(name, document.querySelector(".color-controls"));
        setDeleteUser(name, document.querySelector(".delete-account-btn"));

        if(data.role === "ROLE_ADMIN") {
            document.querySelector("body").classList.add("is-admin");
        } else {
            document.querySelector("body").classList.remove("is-admin");
        }
    } else {
        showError("Issue occurred while retrieving user data.");
    }
};

document.addEventListener("DOMContentLoaded", () => {
    SETTINGS.verifyCredentials()
            .then(updateUserInfo)
            .catch((err) => showError(err.toString()));

});
