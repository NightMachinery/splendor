import "nice-avatar-svg/element";

const choices = {
    bgColor: ["#D2EFF3", "#FFEDEF", "#FFEBA4", "#E0DDFF", "#6BD9E9"],
    hairColor: ["#000000", "#77311D", "#AC6651", "#9287FF"],
    shirtColor: ["#F4D150", "#6BD9E9", "#9287FF", "#FFEBA4"],
    skinColor: ["#F9C9B6", "#AC6651", "#77311D"],
    earSize: ["small", "big"],
    hairStyle: ["normal", "dannyPhantom", "dougFunny", "fonze", "mrT", "pixie", "turban"],
    noseStyle: ["curve", "round", "pointed"],
    glassesStyle: ["", "round", "square"],
    eyesStyle: ["base", "smiling", "round", "shadow"],
    facialHairStyle: ["", "beard", "scruff"],
    mouthStyle: ["smile", "laughing", "nervous", "pucker", "sad", "smirk"],
    shirtStyle: ["open", "collared", "crew"],
    earRing: ["", "hoop"],
    eyebrowsStyle: ["up", "down", "eyelashesUp", "eyelashesDown"]
};

const hashString = (value) => {
    let hash = 2166136261;
    for(let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

const pick = (seed, key, offset) => {
    const list = choices[key];
    return list[(seed + offset * 2654435761) % list.length];
};

export const avatarConfig = (identity = "Player") => {
    const seed = hashString(identity);
    const config = { shape: "circle" };
    Object.keys(choices).forEach((key, index) => {
        const value = pick(seed, key, index + 1);
        if(value) config[key] = value;
    });
    return config;
};

export const renderProfileAvatar = (container, user) => {
    if(!container || !user) return;
    const identity = `${user.name || ""}:${user.displayName || ""}`;
    const config = avatarConfig(identity);
    container.innerHTML = "";
    container.style.background = config.bgColor;
    const avatar = document.createElement("nice-avatar");
    Object.entries(config).forEach(([key, value]) => avatar.setAttribute(key, value));
    avatar.setAttribute("aria-label", user.displayName || user.name || "Player avatar");
    container.appendChild(avatar);
};
