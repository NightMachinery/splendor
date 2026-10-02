// @ts-check
/** Small helpers shared by the splendor-browser scripts. */
import { chmodSync, mkdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * --key=value and --flag arguments. A key given more than once becomes an
 * array (in order), so --click=A --click=B works.
 * @param {string[]} argv
 * @returns {Record<string, string | boolean | string[]>}
 */
export function parseArgs(argv) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const a of argv) {
        if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)} (options look like --key=value)`);
        const [k, ...v] = a.slice(2).split("=");
        const value = v.length ? v.join("=") : true;
        if (k in out) out[k] = [...(Array.isArray(out[k]) ? out[k] : [out[k]]), value];
        else out[k] = value;
    }
    return out;
}

/** The last value of a possibly repeated option. @param {unknown} v */
export const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** Every value of a possibly repeated option, as strings. @param {unknown} v @returns {string[]} */
export const many = (v) => (v === undefined || v === false ? [] : (Array.isArray(v) ? v : [v]).map(String));

/**
 * Write JSON readable only by the user (0600), atomically.
 * @param {string} file @param {unknown} data
 */
export function writePrivateJson(file, data) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}

/** @param {string} tool @param {string} msg @param {number} [code] @returns {never} */
export const die = (tool, msg, code = 2) => {
    writeSync(2, `${tool}: ${msg}\n`); // synchronous: process.exit must not cut it off
    process.exit(code);
};

/** A timestamp usable in file names. */
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
