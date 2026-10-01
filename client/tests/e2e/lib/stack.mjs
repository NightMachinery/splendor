// @ts-check
/**
 * Resolve which running Splendor stack the full-stack tests talk to.
 *
 * Plain ES module with no dependencies, so Playwright specs, the Playwright
 * config and plain Node scripts (for example the Chrome CDP skill) share it.
 *
 * Sources, in order of precedence (an explicit variable always wins over the
 * instance file, field by field):
 *   E2E_BASE_URL  origin that serves the client, with /ls and /gs proxied
 *   E2E_LS_URL    Lobby Service base URL (default: E2E_BASE_URL + "/ls")
 *   E2E_GS_URL    Game Service base URL (default: E2E_BASE_URL + "/gs")
 *   E2E_INSTANCE  name of an isolated self-host instance; its
 *                 .self-host/instances/<name>/instance.json supplies
 *                 baseUrl, lsUrl and gsUrl
 *
 * Safety: the tests create users and sessions, so a stack whose hosts are not
 * loopback addresses is refused unless E2E_ALLOW_REMOTE=1 is set.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (client/tests/e2e/lib -> repo). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** @param {string | undefined | null} url */
const strip = (url) => (url || "").trim().replace(/\/+$/, "");

/**
 * Read an isolated instance description written by `./self_host.py instance-start NAME`.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl?: string, lsUrl?: string, gsUrl?: string, file: string }}
 */
export function readInstance(name, env = process.env) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new Error(`E2E_INSTANCE=${JSON.stringify(name)} is not a valid instance name`);
    }
    const root = env.E2E_SELF_HOST_DIR || join(REPO_ROOT, ".self-host");
    const file = join(root, "instances", name, "instance.json");
    if (!existsSync(file)) {
        throw new Error(`E2E_INSTANCE=${name}: ${file} does not exist. Start it with ./self_host.py instance-start ${name}`);
    }
    const data = JSON.parse(readFileSync(file, "utf8"));
    return { baseUrl: data.baseUrl, lsUrl: data.lsUrl, gsUrl: data.gsUrl, file };
}

/**
 * @typedef {object} Stack
 * @property {string | null} instance  instance name, when E2E_INSTANCE was used
 * @property {string | null} baseUrl   client origin (null when only LS/GS URLs were given)
 * @property {string} lsUrl            Lobby Service base URL, no trailing slash
 * @property {string} gsUrl            Game Service base URL, no trailing slash
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Stack | null} null when no stack is configured
 */
export function resolveStack(env = process.env) {
    const instance = strip(env.E2E_INSTANCE) || null;
    /** @type {{ baseUrl?: string, lsUrl?: string, gsUrl?: string }} */
    let inst = {};
    if (instance) inst = readInstance(instance, env);

    const baseUrl = strip(env.E2E_BASE_URL || inst.baseUrl) || null;
    const lsUrl = strip(env.E2E_LS_URL || inst.lsUrl || (baseUrl ? `${baseUrl}/ls` : ""));
    const gsUrl = strip(env.E2E_GS_URL || inst.gsUrl || (baseUrl ? `${baseUrl}/gs` : ""));
    if (!lsUrl || !gsUrl) return null;

    const stack = { instance, baseUrl, lsUrl, gsUrl };
    assertLocalStack(stack, env);
    return stack;
}

/**
 * Refuse non-loopback targets unless explicitly allowed. The e2e helpers
 * create accounts and sessions, which must never land on a public server.
 * @param {Stack} stack
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertLocalStack(stack, env = process.env) {
    if (env.E2E_ALLOW_REMOTE === "1") return;
    for (const url of [stack.baseUrl, stack.lsUrl, stack.gsUrl]) {
        if (!url) continue;
        const host = new URL(url).hostname;
        if (!LOOPBACK_HOSTS.has(host) && !host.endsWith(".localhost")) {
            throw new Error(`Refusing to run e2e tests against non-local host ${host} (${url}). `
                + "They create users and sessions. Use an isolated instance, or set E2E_ALLOW_REMOTE=1 if you really mean it.");
        }
    }
}

/** Short human description, for skip messages and logs. */
export const SKIP_REASON = "No full stack configured: set E2E_INSTANCE, or E2E_BASE_URL, or both E2E_LS_URL and E2E_GS_URL.";
