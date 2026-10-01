import { defineConfig } from "astro/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// https://astro.build/config
import tailwind from "@astrojs/tailwind";

// https://astro.build/config
import react from "@astrojs/react";

// Backend ports used when the SPLENDOR_*_URL variables are unset. These match
// DEFAULT_PORTS in ../self_host.py; .self-host/ports.json overrides them.
const DEFAULT_BACKEND_PORTS = { lobby: 34172, game: 33402 };

const selfHostPorts = () => {
    try {
        const file = fileURLToPath(new URL("../.self-host/ports.json", import.meta.url));
        return { ...DEFAULT_BACKEND_PORTS, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
        return DEFAULT_BACKEND_PORTS;
    }
};

const ports = selfHostPorts();
const lsTarget = process.env.SPLENDOR_LS_URL || `http://127.0.0.1:${ports.lobby}`;
const gsTarget = process.env.SPLENDOR_GS_URL || `http://127.0.0.1:${ports.game}`;

// The client always calls `${origin}/ls` and `${origin}/gs`. In production
// Caddy strips those prefixes with handle_path; this dev-server proxy does the
// same, so `astro dev` works without Caddy (for example on macOS).
const stripPrefixProxy = (target, prefix) => ({
    target,
    changeOrigin: true,
    rewrite: (path) => path.replace(prefix, "") || "/",
});

// https://astro.build/config
export default defineConfig({
    // self_host.py builds release copies into a staging directory first.
    outDir: process.env.SPLENDOR_DIST_DIR || "./dist",
    integrations: [tailwind(), react()],
    vite: {
        // Lets several isolated dev servers run from this checkout at once.
        ...(process.env.SPLENDOR_VITE_CACHE_DIR ? { cacheDir: process.env.SPLENDOR_VITE_CACHE_DIR } : {}),
        // fix weird issue on mac
        optimizeDeps: {
            exclude: ["fsevents"]
        },
        server: {
            proxy: {
                "^/ls(/|$)": stripPrefixProxy(lsTarget, /^\/ls/),
                "^/gs(/|$)": stripPrefixProxy(gsTarget, /^\/gs/),
            }
        }
    }
});
