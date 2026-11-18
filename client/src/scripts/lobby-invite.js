export const readLobbyInvite = () => {
    const id = new URLSearchParams(window.location.search).get("invite");
    // Lobby Service session IDs are signed longs. Keep them as strings.
    return id && /^-?\d{1,19}$/.test(id) ? id : null;
};

export const withLobbyInvite = (path, sessionId) => sessionId
    ? `${path}?${new URLSearchParams({ invite: sessionId })}`
    : path;
