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

// The same service-only rules as the Caddy front (site_routes in
// ../self_host.py), so a dev server is no more open than production:
// - /ls: anything but GET on a path containing /gameservices (game service
//   registration and savegame writes; the GS calls the LS directly);
// - /gs: every PUT except a player action, which blocks the unauthenticated
//   LS->GS launch call PUT /api/sessions/{id} (the LS calls the GS directly).
// A segment may not start with a dot, so ".." can never pass as an id.
const SEGMENT = "[A-Za-z0-9_~-][A-Za-z0-9_.~-]*";
const GS_PLAYER_ACTION_RE = new RegExp(`^/api/sessions/${SEGMENT}/players/${SEGMENT}/actions/${SEGMENT}$`);

const decodedPath = (url) => {
    const raw = (url || "/").split("?")[0];
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
};

const isServiceOnlyRoute = (method, url) => {
    const path = decodedPath(url);
    if (/^\/ls(\/|$)/.test(path)) {
        return method !== "GET" && /\/gameservices/i.test(path.slice(3));
    }
    if (/^\/gs(\/|$)/.test(path)) {
        return method === "PUT" && !GS_PLAYER_ACTION_RE.test(path.slice(3));
    }
    return false;
};

// configureServer middlewares run before Vite's own, including the proxy.
const blockServiceOnlyRoutes = () => ({
    name: "splendor-block-service-only-routes",
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (isServiceOnlyRoute(req.method, req.url)) {
                res.statusCode = 403;
                res.setHeader("content-type", "text/plain; charset=utf-8");
                res.end("Forbidden: service-only route");
                return;
            }
            next();
        });
    },
});

// https://astro.build/config
export default defineConfig({
    // self_host.py builds release copies into a staging directory first.
    outDir: process.env.SPLENDOR_DIST_DIR || "./dist",
    integrations: [tailwind(), react()],
    vite: {
        plugins: [blockServiceOnlyRoutes()],
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
