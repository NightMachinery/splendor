import { toast } from "react-toastify";

const errorText = (msg) => msg instanceof Error ? (msg.stack || msg.message) : String(msg);

export const startToastLoad = (msg) => {
    return toast.loading(msg, {
        position: "top-center",
        pauseOnHover: true,
        theme: "colored",
    });
};

export const updateToastLoad = (id, msg, type, timeout = 4000) => {
    if(type === "error") console.error(errorText(msg));
    toast.update(id, { render: msg, type: type, isLoading: false, autoClose: timeout });
};

export const showError = (msg, timeout = 4000) => {
    console.error(errorText(msg));
    toast.error(msg, {
        position: "top-center",
        autoClose: timeout,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        theme: "colored",
    });
};

export const showSuccess = (msg, timeout = 2500) => {
    toast.success(msg, {
        position: "top-center",
        autoClose: timeout,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        theme: "colored",
    });
};
