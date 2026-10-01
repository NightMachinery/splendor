#!/usr/bin/env node
/**
 * CSS lint for the board redesign. No dependencies. See docs/ui/foundations.md.
 *
 *   node tools/lint-css.mjs              lint src/ and public/: CSS files, .astro <style>
 *                                        blocks, static style="" attributes, viewport metas
 *   node tools/lint-css.mjs FILE...      lint only these files (relative to client/ or absolute)
 *   node tools/lint-css.mjs --self-test  check every rule against built-in fixtures
 *   node tools/lint-css.mjs --contrast   print the token contrast report
 *   node tools/lint-css.mjs --summary    per-file counts, including allowlisted findings
 *   node tools/lint-css.mjs --rules      list the rules
 *
 *   --strict   stale allowlist entries are errors instead of warnings
 *   --verbose  also print the allowlisted (suppressed) findings
 *
 * Legacy files that are not converted yet are listed, with the rules they may
 * still break, in tools/lint-css.allow.json. Remove a file's entry when you
 * convert it.
 *
 * Exit status: 0 clean, 1 findings or a failed self-test, 2 usage or I/O error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src", "public"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".astro"]);
export const TOKENS_FILE = "src/styles/sp/tokens.css";
const ALLOW_FILE = "tools/lint-css.allow.json";

// Section 0 of the UX spec. These strings are a contract: copy them exactly.
export const MEDIA = {
    T: "(min-width: 700px) and (min-height: 501px)",
    D: "(min-width: 1024px) and (min-height: 501px)",
    W: "(min-width: 1600px) and (min-height: 800px)",
    L: "(orientation: landscape) and (max-height: 500px)",
    hover: "(hover: hover) and (pointer: fine)",
    motion: "(prefers-reduced-motion: reduce)",
};
const CONTRACT_MEDIA = new Set(Object.values(MEDIA));
const LAYOUT_WIDTHS = [700, 1024, 1600];
export const VIEWPORT_META = "width=device-width, initial-scale=1, viewport-fit=cover";

export const RULES = {
    "parse": "The CSS parses: balanced braces, closed comments and strings, no stray text.",
    "media-range": "Media queries use min-/max- features, never range syntax such as (width <= 700px).",
    "media-contract":
        "A media query on orientation, height, hover, pointer or reduced motion, or at a layout width " +
        "(700, 1024 or 1600px), is one of the section 0 strings, copied exactly.",
    "at-layer": "No @layer and no @import ... layer().",
    "nesting": "No CSS nesting: no nested rules, no &, no @nest.",
    "color-mix": "No color-mix().",
    "z-index": "z-index is var(--z-*) or a keyword; raw numbers only in tokens.css.",
    "viewport-height": "No 100vh, 100dvh, 100svh or 100lvh outside tokens.css; use var(--sp-vh).",
    "safe-area": "No env(safe-area-inset-*) outside tokens.css; use var(--sp-safe-t/r/b/l).",
    "background-fixed": "No background-attachment: fixed; draw a position: fixed ::before layer instead.",
    "root-overflow": "No overflow-x: hidden or clip (nor overflow: hidden or clip) on html, :root or body.",
    "fixed-ancestor":
        "html, body, #game-elements, .board-container and #board never get transform, translate, rotate, " +
        "scale, filter, backdrop-filter, perspective, contain, will-change, container or content-visibility, " +
        "which would capture their position: fixed descendants.",
    "hover-media": `:hover rules sit inside @media ${MEDIA.hover}; nothing depends on hover.`,
    "font-family": "font-family and the font shorthand use var(--sp-font-*).",
    "viewport-meta": `A viewport meta reads exactly "${VIEWPORT_META}", and every page has one (BaseHead renders it).`,
    "contrast": "Text tokens are at least 4.5:1 on --sp-bg, --sp-surface-1 and --sp-surface-2 (tokens.css).",
};

// ---------------------------------------------------------------------------
// CSS parsing: a small tolerant parser producing at-rules, style rules and
// declarations with their line numbers.

const countNewlines = (s) => {
    let n = 0;
    for (const ch of s) if (ch === "\n") n++;
    return n;
};

export function parseCss(css, firstLine = 1) {
    const root = { type: "root", children: [], line: firstLine };
    const stack = [root];
    const errors = [];
    let buf = "";
    let bufLine = firstLine;
    let line = firstLine;
    let parens = 0;

    const append = (text) => {
        if (!buf.trim() && text.trim()) bufLine = line;
        buf += text;
    };
    const atRule = (text, withBlock) => {
        const m = /^@([\w-]+)([\s\S]*)$/.exec(text);
        return {
            type: "at",
            name: (m ? m[1] : "").toLowerCase(),
            prelude: (m ? m[2] : text).trim(),
            line: bufLine,
            children: withBlock ? [] : null,
        };
    };
    const flush = () => {
        const text = buf.trim();
        buf = "";
        if (!text) return;
        const parent = stack[stack.length - 1];
        if (text.startsWith("@")) {
            parent.children.push(atRule(text, false));
            return;
        }
        const colon = text.indexOf(":");
        if (colon <= 0) {
            errors.push({ line: bufLine, message: `stray text "${text.slice(0, 40)}"` });
            return;
        }
        let prop = text.slice(0, colon).trim();
        let value = text.slice(colon + 1).trim();
        let important = false;
        const imp = /!\s*important\s*$/i.exec(value);
        if (imp) {
            important = true;
            value = value.slice(0, imp.index).trim();
        }
        if (!prop.startsWith("--")) prop = prop.toLowerCase();
        parent.children.push({ type: "decl", prop, value, important, line: bufLine });
    };

    let i = 0;
    while (i < css.length) {
        const ch = css[i];
        if (ch === "/" && css[i + 1] === "*") {
            const end = css.indexOf("*/", i + 2);
            if (end < 0) {
                errors.push({ line, message: "unclosed comment" });
                break;
            }
            line += countNewlines(css.slice(i, end + 2));
            buf += " ";
            i = end + 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < css.length && css[j] !== ch && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
            if (css[j] !== ch) errors.push({ line, message: "unclosed string" });
            append(css.slice(i, j + 1));
            i = j + 1;
            continue;
        }
        if (ch === "(") parens++;
        else if (ch === ")") parens = Math.max(0, parens - 1);
        if (parens === 0 && (ch === "{" || ch === "}" || ch === ";")) {
            if (ch === "{") {
                const prelude = buf.trim();
                buf = "";
                const parent = stack[stack.length - 1];
                const node = prelude.startsWith("@")
                    ? atRule(prelude, true)
                    : { type: "rule", selector: prelude, line: bufLine, children: [] };
                parent.children.push(node);
                stack.push(node);
            } else if (ch === ";") {
                flush();
            } else {
                flush();
                if (stack.length > 1) stack.pop();
                else errors.push({ line, message: "unexpected }" });
            }
            i++;
            continue;
        }
        if (ch === "\n") {
            buf += ch;
            line++;
        } else {
            append(ch);
        }
        i++;
    }
    flush();
    for (const open of stack.slice(1)) {
        errors.push({ line: open.line, message: `unclosed block "${(open.selector ?? "@" + open.name).slice(0, 40)}"` });
    }
    return { root, errors };
}

// ---------------------------------------------------------------------------
// Selector helpers.

/** Split on a separator at depth 0, outside strings, (), []. */
export function splitTopLevel(s, sep = ",") {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = "";
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0 && !quote) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

/** Replace the insides of strings, () and [] with "_" so only the outer structure remains. */
function maskNested(s) {
    let out = "";
    let depth = 0;
    let quote = null;
    for (const ch of s) {
        if (quote) {
            out += "_";
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            out += "_";
            continue;
        }
        if (ch === "(" || ch === "[") {
            out += depth === 0 ? ch : "_";
            depth++;
            continue;
        }
        if (ch === ")" || ch === "]") {
            depth = Math.max(0, depth - 1);
            out += depth === 0 ? ch : "_";
            continue;
        }
        out += depth > 0 ? "_" : ch;
    }
    return out;
}

const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)(?![\w-])/i;

/**
 * Which protected element a selector's subject (its last compound) targets:
 * "html", "body", ":root", "#board", ... or null. Pseudo-elements are not
 * the element itself, so body::before is not body.
 */
function protectedSubjects(selector) {
    const hits = [];
    for (const complex of splitTopLevel(selector)) {
        const masked = maskNested(complex);
        let k = masked.length - 1;
        while (k >= 0 && !/[\s>+~]/.test(masked[k])) k--;
        const compound = masked.slice(k + 1);
        if (!compound || PSEUDO_ELEMENT.test(compound)) continue;
        const type = /^(html|body)(?![\w-])/i.exec(compound);
        if (type) hits.push(type[1].toLowerCase());
        if (/:root(?![\w-])/i.test(compound)) hits.push(":root");
        for (const m of compound.matchAll(/(#game-elements|#board|\.board-container|\.game-elements|\.board)(?![\w-])/g)) {
            hits.push(m[1]);
        }
    }
    return [...new Set(hits)];
}

// ---------------------------------------------------------------------------
// Rules.

const KEYWORDS = "inherit|initial|unset|revert|revert-layer";
const Z_OK = new RegExp(`^(var\\(--z-[\\w-]+\\)|auto|${KEYWORDS})$`, "i");
const FONT_FAMILY_OK = new RegExp(`^(var\\(--sp-font-[\\w-]+\\)|${KEYWORDS})$`, "i");
const FONT_KEYWORD = new RegExp(`^(${KEYWORDS})$`, "i");
const VH_100 = /(?<![\w.-])100(?:d|s|l)?vh(?![\w-])/i;
const SAFE_ENV = /\benv\(\s*safe-area-inset-/i;
const RANGE_FEATURE = /\([^()]*[<>=][^()]*\)/;
const LAYOUT_FEATURE =
    /^(orientation|(min-|max-)?(device-)?height|(any-)?hover|(any-)?pointer|prefers-reduced-motion|(min-|max-)?(device-)?aspect-ratio)$/;

// Properties that make an element the containing block of position: fixed
// descendants (or a scroll/paint container that breaks them), with the
// values that do not.
const FIXED_ANCESTOR_PROPS = {
    "transform": "none",
    "-webkit-transform": "none",
    "translate": "none",
    "rotate": "none",
    "scale": "none",
    "filter": "none",
    "-webkit-filter": "none",
    "backdrop-filter": "none",
    "-webkit-backdrop-filter": "none",
    "perspective": "none",
    "-webkit-perspective": "none",
    "contain": "none",
    "will-change": "auto",
    "container-type": "normal",
    "container": "none",
    "content-visibility": "visible",
};

export function normalizeMedia(q) {
    return q
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/\s*:\s*/g, ": ")
        .trim();
}

function mediaFindings(prelude) {
    const out = [];
    for (const query of splitTopLevel(prelude)) {
        if (RANGE_FEATURE.test(query)) {
            out.push(["media-range", `range syntax in "@media ${query}"; use min-/max- features`]);
            continue;
        }
        const n = normalizeMedia(query);
        if (CONTRACT_MEDIA.has(n)) continue;
        const features = [...n.matchAll(/\(([a-z-]+)/g)].map((m) => m[1]);
        const layout = features.filter((f) => LAYOUT_FEATURE.test(f));
        if (layout.length) {
            out.push([
                "media-contract",
                `"@media ${query}" uses ${layout.join(", ")} but is not a section 0 string; copy the contract query exactly`,
            ]);
            continue;
        }
        for (const m of n.matchAll(/\((min|max)-width: ([\d.]+)px\)/g)) {
            if (LAYOUT_WIDTHS.some((t) => Math.abs(Number(m[2]) - t) <= 1)) {
                out.push([
                    "media-contract",
                    `"@media ${query}" is a layout-class width without its height condition; use the full section 0 string`,
                ]);
                break;
            }
        }
    }
    return out;
}

function lintTree(root, { isTokens }, add) {
    const visit = (nodes, ancestors) => {
        for (const node of nodes) {
            const styleAncestor = ancestors.some((a) => a.type === "rule");
            if (node.type === "at") {
                if (node.name === "layer") add(node.line, "at-layer", `@layer ${node.prelude}`.trim());
                if (node.name === "import" && /\blayer\b/i.test(node.prelude)) add(node.line, "at-layer", "@import into a layer");
                if (node.name === "nest") add(node.line, "nesting", "@nest");
                else if (styleAncestor && node.children) add(node.line, "nesting", `@${node.name} nested inside a style rule`);
                if (node.name === "media") for (const [rule, msg] of mediaFindings(node.prelude)) add(node.line, rule, msg);
            } else if (node.type === "rule") {
                const plain = maskNested(node.selector);
                if (styleAncestor) add(node.line, "nesting", `rule "${node.selector}" nested inside a style rule`);
                else if (plain.includes("&")) add(node.line, "nesting", `"&" in selector "${node.selector}"`);
                const inKeyframes = ancestors.some((a) => a.type === "at" && /keyframes$/.test(a.name));
                if (!inKeyframes && /:hover(?![\w-])/i.test(plain)) {
                    const hoverMedia = ancestors.some((a) => a.type === "at" && a.name === "media" && normalizeMedia(a.prelude) === MEDIA.hover);
                    if (!hoverMedia) add(node.line, "hover-media", `"${node.selector}" is outside @media ${MEDIA.hover}`);
                }
            } else if (node.type === "decl") {
                const parent = ancestors[ancestors.length - 1];
                if (!parent || parent.type === "root") {
                    add(node.line, "parse", `declaration "${node.prop}" outside any rule`);
                } else if (parent.type === "rule") {
                    lintDecl(node, parent.selector, isTokens, add);
                }
                // Declarations directly in an at-rule are descriptors (@font-face, @page, @property).
            }
            if (node.children) visit(node.children, [...ancestors, node]);
        }
    };
    visit(root.children, []);
}

function lintDecl(decl, selector, isTokens, add) {
    const { prop, value, line } = decl;
    if (/\bcolor-mix\(/i.test(value)) add(line, "color-mix", `${prop}: ${value}`);
    if (!isTokens && VH_100.test(value)) add(line, "viewport-height", `${prop}: ${value}`);
    if (!isTokens && SAFE_ENV.test(value)) add(line, "safe-area", `${prop}: ${value}`);
    if (prop.startsWith("--")) return;

    if (prop === "z-index" && !isTokens && !Z_OK.test(value)) add(line, "z-index", `z-index: ${value}`);
    if (prop === "background-attachment" && /\bfixed\b/i.test(value)) add(line, "background-fixed", `${prop}: ${value}`);
    if (prop === "background" && /\bfixed\b/i.test(value.replace(/url\([^)]*\)/gi, ""))) {
        add(line, "background-fixed", `${prop}: ${value}`);
    }
    if (prop === "font-family" && !FONT_FAMILY_OK.test(value)) add(line, "font-family", `font-family: ${value}`);
    if (prop === "font" && !FONT_KEYWORD.test(value) && !/var\(--sp-font-/i.test(value)) add(line, "font-family", `font: ${value}`);

    const subjects = protectedSubjects(selector);
    if (!subjects.length) return;
    const roots = subjects.filter((s) => s === "html" || s === "body" || s === ":root");
    if (roots.length) {
        const first = value.trim().split(/\s+/)[0].toLowerCase();
        if ((prop === "overflow-x" || prop === "overflow") && (first === "hidden" || first === "clip")) {
            add(line, "root-overflow", `${prop}: ${value} on ${roots.join(", ")}`);
        }
    }
    if (prop in FIXED_ANCESTOR_PROPS) {
        const v = value.trim().toLowerCase();
        if (v !== FIXED_ANCESTOR_PROPS[prop] && !FONT_KEYWORD.test(v)) {
            add(line, "fixed-ancestor", `${prop}: ${value} on ${subjects.join(", ")}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Files: CSS, and .astro/.html (style blocks, style attributes, viewport metas).

const lineAt = (text, index) => 1 + countNewlines(text.slice(0, index));

export function lintCss(css, { isTokens = false, firstLine = 1 } = {}) {
    const findings = [];
    const add = (line, rule, message) => findings.push({ line, rule, message: message.replace(/\s+/g, " ") });
    const { root, errors } = parseCss(css, firstLine);
    for (const e of errors) add(e.line, "parse", e.message);
    lintTree(root, { isTokens }, add);
    return findings;
}

function lintMarkup(text, rel) {
    const findings = [];
    let viewportMetas = 0;
    for (const m of text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
        if (/\blang=["']?(scss|sass|less|stylus|styl)/i.test(m[1])) continue;
        const start = m.index + m[0].indexOf(">") + 1;
        findings.push(...lintCss(m[2], { firstLine: lineAt(text, start) }));
    }
    for (const m of text.matchAll(/<([a-zA-Z][\w-]*)(\s[^<>]*?)?\/?>/g)) {
        const tag = m[1].toLowerCase();
        const attrs = m[2] || "";
        const line = lineAt(text, m.index);
        if (tag === "meta" && /\bname=["']viewport["']/i.test(attrs)) {
            viewportMetas++;
            const content = /\bcontent=["']([^"']*)["']/i.exec(attrs);
            const got = content ? content[1].split(",").map((s) => s.trim()).filter(Boolean).join(", ") : "";
            if (got !== VIEWPORT_META) {
                findings.push({ line, rule: "viewport-meta", message: `viewport is "${content ? content[1] : ""}"` });
            }
        }
        const style = /\sstyle="([^"]*)"/i.exec(attrs);
        if (!style || /\{/.test(style[1])) continue;
        const id = /\sid="([\w-]+)"/i.exec(attrs);
        const classes = /\sclass="([^"{}]*)"/i.exec(attrs);
        const selector =
            tag + (id ? `#${id[1]}` : "") + (classes ? classes[1].trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join("") : "");
        for (const f of lintCss(`${selector}{${style[1]}}`, { firstLine: line })) {
            findings.push({ ...f, message: `style attribute: ${f.message}` });
        }
    }
    // A page must set the viewport, directly or through BaseHead.
    const html = /<html\b/i.exec(text);
    if (/^src\/pages\//.test(rel) && html && !viewportMetas && !/<BaseHead\b/.test(text)) {
        findings.push({ line: lineAt(text, html.index), rule: "viewport-meta", message: "page has no viewport meta; render <BaseHead /> in its <head>" });
    }
    return findings;
}

/** Lint one file's text. `file` is the path relative to client/, used for the tokens.css exemption. */
export function lintText(file, text) {
    const rel = file.split(path.sep).join("/");
    if (rel.endsWith(".css")) return lintCss(text, { isTokens: rel === TOKENS_FILE || rel.endsWith("/" + TOKENS_FILE) });
    if (rel.endsWith(".astro") || rel.endsWith(".html")) return lintMarkup(text, rel);
    return [];
}

// ---------------------------------------------------------------------------
// Contrast probe over tokens.css.

function parseColor(v) {
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (m) {
        const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
    }
    m = /^rgba?\(([^)]*)\)$/.exec(s);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean);
        const [r, g, b] = parts.slice(0, 3).map(Number);
        const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : Number(parts[3]);
        return [r, g, b, a];
    }
    return null;
}

const channel = (c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
export function contrastRatio(fg, bg) {
    const a = luminance(over(fg, bg));
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The colour tokens declared in top-level :root rules, with var() references resolved. */
export function colourTokens(css) {
    const raw = new Map();
    for (const node of parseCss(css).root.children) {
        if (node.type !== "rule" || !splitTopLevel(node.selector).includes(":root")) continue;
        for (const d of node.children) if (d.type === "decl" && d.prop.startsWith("--")) raw.set(d.prop, d.value);
    }
    const resolve = (name, seen = new Set()) => {
        const v = raw.get(name);
        if (v === undefined || seen.has(name)) return null;
        const ref = /^var\((--[\w-]+)\)$/.exec(v.trim());
        if (ref) return resolve(ref[1], new Set([...seen, name]));
        return parseColor(v);
    };
    const out = new Map();
    for (const name of raw.keys()) {
        const c = resolve(name);
        if (c) out.set(name, c);
    }
    return out;
}

const SURFACES = ["--sp-bg", "--sp-surface-1", "--sp-surface-2"];
const TEXT_TOKENS = ["--sp-text", "--sp-text-muted", "--sp-gold", "--sp-ok", "--sp-warn", "--sp-danger"];
const GEMS = ["white", "blue", "green", "red", "brown", "gold"];
const GEM_INK = { white: "--sp-gem-ink-dark", gold: "--sp-gem-ink-dark" };

/**
 * Contrast checks: `required` pairs fail the lint (text 4.5:1, focus ring 3:1);
 * `advisory` pairs (gem numerals and gem shapes on the dark surfaces) are reported only.
 */
export function contrastChecks(css) {
    const t = colourTokens(css);
    const checks = [];
    const pair = (fg, bg, min, kind, what) => {
        const f = t.get(fg);
        const b = t.get(bg);
        if (!f || !b) {
            checks.push({ fg, bg, min, kind, what, ratio: NaN, ok: kind !== "required" });
            return;
        }
        const ratio = contrastRatio(f, b);
        checks.push({ fg, bg, min, kind, what, ratio, ok: ratio >= min });
    };
    for (const fg of TEXT_TOKENS) for (const bg of SURFACES) pair(fg, bg, 4.5, "required", "text");
    pair("--sp-gold-ink", "--sp-gold", 4.5, "required", "primary button text");
    pair("--sp-text", "--sp-final", 4.5, "required", "final-round pill text");
    for (const bg of SURFACES) pair("--sp-focus", bg, 3, "required", "focus ring");
    for (const gem of GEMS) pair(GEM_INK[gem] || "--sp-gem-ink-light", `--sp-gem-${gem}`, 4.5, "advisory", "gem numeral");
    for (const gem of GEMS) for (const bg of ["--sp-bg", "--sp-surface-1"]) pair(`--sp-gem-${gem}`, bg, 3, "advisory", "gem shape");
    return checks;
}

// ---------------------------------------------------------------------------
// Self-test fixtures: each lists exactly the rules it must produce.

const FIXTURES = [
    { name: "range media query", file: "src/x.css", css: "@media (width <= 700px) { .a { color: red; } }", expect: ["media-range"] },
    { name: "@layer", file: "src/x.css", css: "@layer base { .a { color: red; } }", expect: ["at-layer"] },
    { name: "@import into a layer", file: "src/x.css", css: '@import url("x.css") layer(base);', expect: ["at-layer"] },
    {
        name: "&:hover nesting",
        file: "src/x.css",
        css: ".a { color: red; &:hover { color: blue; } }",
        expect: ["nesting", "hover-media"],
    },
    { name: "nested rule", file: "src/x.css", css: ".a { .b { color: red; } }", expect: ["nesting"] },
    { name: "@media nested in a rule", file: "src/x.css", css: `.a { @media ${MEDIA.T} { color: red; } }`, expect: ["nesting"] },
    { name: "z-index: 5", file: "src/x.css", css: ".a { z-index: 5; }", expect: ["z-index"] },
    { name: "z-index calc offset", file: "src/x.css", css: ".a { z-index: calc(var(--z-sheet) + 1); }", expect: ["z-index"] },
    { name: "z-index: 5 in tokens.css", file: TOKENS_FILE, css: ".a { z-index: 5; }", expect: [] },
    { name: "height: 100vh", file: "src/x.css", css: ".a { height: 100vh; }", expect: ["viewport-height"] },
    { name: "calc(100dvh)", file: "src/x.css", css: ".a { max-height: calc(100dvh - 8px); }", expect: ["viewport-height"] },
    { name: "height: 100vh in tokens.css", file: TOKENS_FILE, css: ":root { --sp-vh: 100vh; } .a { height: 100vh; }", expect: [] },
    {
        name: "env(safe-area-inset-left)",
        file: "src/x.css",
        css: ".a { padding-left: env(safe-area-inset-left); }",
        expect: ["safe-area"],
    },
    {
        name: "env(safe-area-inset-left) in tokens.css",
        file: TOKENS_FILE,
        css: ":root { --sp-safe-l: env(safe-area-inset-left, 0px); }",
        expect: [],
    },
    { name: "color-mix()", file: "src/x.css", css: ".a { color: color-mix(in srgb, red, blue); }", expect: ["color-mix"] },
    { name: "background-attachment: fixed", file: "src/x.css", css: "body { background-attachment: fixed; }", expect: ["background-fixed"] },
    {
        name: "background shorthand fixed",
        file: "src/x.css",
        css: '.a { background: url("/fixed.jpg") center / cover fixed; }',
        expect: ["background-fixed"],
    },
    { name: "body overflow-x: hidden", file: "src/x.css", css: "body { overflow-x: hidden; }", expect: ["root-overflow"] },
    { name: "html overflow: hidden", file: "src/x.css", css: "html, .x { overflow: hidden; }", expect: ["root-overflow"] },
    { name: "#board transform", file: "src/x.css", css: "#game-elements #board { transform: translateZ(0); }", expect: ["fixed-ancestor"] },
    {
        name: ".board-container will-change",
        file: "src/x.css",
        css: "body[data-sp-turn] .board-container { will-change: transform; }",
        expect: ["fixed-ancestor"],
    },
    { name: "body filter", file: "src/x.css", css: "body.x { filter: blur(2px); }", expect: ["fixed-ancestor"] },
    { name: ":hover outside the hover query", file: "src/x.css", css: ".a:hover { color: red; }", expect: ["hover-media"] },
    {
        name: "(hover: hover) alone",
        file: "src/x.css",
        css: "@media (hover: hover) { .a:hover { color: red; } }",
        expect: ["media-contract", "hover-media"],
    },
    {
        name: "layout width without height",
        file: "src/x.css",
        css: "@media (min-width: 1024px) { .a { color: red; } }",
        expect: ["media-contract"],
    },
    {
        name: "drifted landscape query",
        file: "src/x.css",
        css: "@media (orientation: landscape) and (max-height: 480px) { .a { color: red; } }",
        expect: ["media-contract"],
    },
    { name: "raw font-family", file: "src/x.css", css: ".a { font-family: Lobster, cursive; }", expect: ["font-family"] },
    { name: "raw font shorthand", file: "src/x.css", css: ".a { font: 600 16px Arial; }", expect: ["font-family"] },
    { name: "unbalanced braces", file: "src/x.css", css: ".a { color: red;", expect: ["parse"] },
    {
        name: "astro: viewport meta, style block and style attribute",
        file: "src/x.astro",
        css:
            '---\nconst a = 1;\n---\n<meta name="viewport" content="width=device-width" />\n' +
            '<div id="board" style="transform: scale(2)"></div>\n<style>\n.a { z-index: 3; }\n</style>\n',
        expect: ["viewport-meta", "fixed-ancestor", "z-index"],
        lines: { "viewport-meta": 4, "fixed-ancestor": 5, "z-index": 7 },
    },
    {
        name: "page without a viewport meta",
        file: "src/pages/x.astro",
        css: "---\n---\n<html>\n<head><title>x</title></head>\n</html>\n",
        expect: ["viewport-meta"],
        lines: { "viewport-meta": 3 },
    },
    {
        name: "page using BaseHead",
        file: "src/pages/x.astro",
        css: '---\nimport BaseHead from "../components/BaseHead.astro";\n---\n<html>\n<head><BaseHead title="x" /></head>\n</html>\n',
        expect: [],
    },
    {
        name: "clean file",
        file: "src/x.css",
        css: [
            "/* a { z-index: 5 } in a comment is ignored */",
            '@font-face { font-family: "Judson"; src: url("/fonts/judson/x.woff2") format("woff2"); }',
            ".a { z-index: var(--z-sheet); height: var(--sp-vh); padding-left: max(8px, var(--sp-safe-l)); }",
            ".b { font: 600 var(--sp-fs-md) / 1.2 var(--sp-font-ui); font-family: var(--sp-font-display); }",
            "body::before { content: \"\"; position: fixed; transform: none; z-index: var(--z-backdrop); }",
            ".board-tokens, .board-cards { transform: translateY(2px); }",
            "#board { contain: none; } body { overflow-y: auto; }",
            `@media ${MEDIA.T} { .a { color: red; } }`,
            `@media ${MEDIA.D} { .a { color: red; } }`,
            `@media ${MEDIA.W} { .a { color: red; } }`,
            `@media ${MEDIA.L} { .a { color: red; } }`,
            `@media ${MEDIA.motion} { .a { transition: none; } }`,
            `@media ${MEDIA.hover} { .a:hover { color: red; } @media ${MEDIA.T} { .b:hover { color: blue; } } }`,
            "@media (min-width: 400px) { :root { --sp-gutter: 12px; } }",
            "@media print { .a { display: none; } }",
            "@supports (height: 100dvh) { .a { color: red; } }",
            "@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }",
            '.c[data-x="a&b"]::after { content: "&:hover { }"; }',
        ].join("\n"),
        expect: [],
    },
];

const CONTRAST_FIXTURE = [
    ":root {",
    "  --sp-bg: #0b1422; --sp-surface-1: #12203a; --sp-surface-2: #1a2b4a;",
    "  --sp-text: #f3efe6; --sp-text-muted: #333333; --sp-gold: #e8b84a; --sp-gold-ink: #1d1503;",
    "  --sp-ok: #4cc38a; --sp-warn: #f0a020; --sp-danger: #ff6b5e; --sp-focus: #ffd76a; --sp-final: #b3263e;",
    "}",
].join("\n");

function selfTest() {
    let failed = 0;
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    for (const fx of FIXTURES) {
        const findings = lintText(fx.file, fx.css);
        const got = [...new Set(findings.map((f) => f.rule))].sort();
        const want = [...new Set(fx.expect)].sort();
        let ok = sameSet(got, want);
        let detail = ok ? "" : `expected [${want.join(", ")}], got [${got.join(", ")}]`;
        for (const [rule, line] of Object.entries(fx.lines || {})) {
            const f = findings.find((x) => x.rule === rule);
            if (!f || f.line !== line) {
                ok = false;
                detail += ` ${rule} expected on line ${line}, got ${f ? f.line : "none"}`;
            }
        }
        console.log(`${ok ? "ok  " : "FAIL"}  ${fx.name}${want.length ? ` -> ${want.join(", ")}` : " -> clean"}${detail ? `  (${detail.trim()})` : ""}`);
        if (!ok) failed++;
    }
    const bad = contrastChecks(CONTRAST_FIXTURE).filter((c) => c.kind === "required" && !c.ok);
    const contrastOk = bad.length > 0 && bad.every((c) => c.fg === "--sp-text-muted");
    console.log(`${contrastOk ? "ok  " : "FAIL"}  low-contrast --sp-text-muted -> contrast`);
    if (!contrastOk) failed++;
    const real = existsSync(path.join(CLIENT, TOKENS_FILE)) ? readFileSync(path.join(CLIENT, TOKENS_FILE), "utf8") : null;
    if (real) {
        const realBad = contrastChecks(real).filter((c) => c.kind === "required" && !c.ok);
        console.log(`${realBad.length ? "FAIL" : "ok  "}  ${TOKENS_FILE} meets the required contrast`);
        if (realBad.length) failed++;
    }
    const total = FIXTURES.length + 1 + (real ? 1 : 0);
    console.log(`\nlint-css self-test: ${total - failed}/${total} passed`);
    return failed === 0 ? 0 : 1;
}

function printContrast() {
    const file = path.join(CLIENT, TOKENS_FILE);
    const checks = contrastChecks(readFileSync(file, "utf8"));
    let failures = 0;
    for (const kind of ["required", "advisory"]) {
        console.log(kind === "required" ? "Required (fails the lint):" : "\nAdvisory (reported only):");
        for (const c of checks.filter((x) => x.kind === kind)) {
            const mark = c.ok ? "ok  " : kind === "required" ? "FAIL" : "warn";
            if (!c.ok && kind === "required") failures++;
            const ratio = Number.isNaN(c.ratio) ? "missing" : `${c.ratio.toFixed(2)}:1`;
            console.log(`  ${mark}  ${c.what.padEnd(22)} ${c.fg} on ${c.bg}  ${ratio} (min ${c.min}:1)`);
        }
    }
    return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI.

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.(css|astro|html)$/.test(name)) out.push(full);
    }
    return out;
}

function loadAllowlist() {
    const file = path.join(CLIENT, ALLOW_FILE);
    if (!existsSync(file)) return {};
    const json = JSON.parse(readFileSync(file, "utf8"));
    return json.files || {};
}

function main(argv) {
    const flags = new Set(argv.filter((a) => a.startsWith("--")));
    const known = ["--self-test", "--contrast", "--summary", "--rules", "--strict", "--verbose", "--help"];
    const unknown = [...flags].filter((f) => !known.includes(f));
    if (unknown.length || flags.has("--help")) {
        if (unknown.length) console.error(`unknown option ${unknown.join(", ")}`);
        console.error("usage: node tools/lint-css.mjs [--self-test | --contrast | --summary | --rules] [--strict] [--verbose] [FILE...]");
        return unknown.length ? 2 : 0;
    }
    if (flags.has("--rules")) {
        for (const [id, text] of Object.entries(RULES)) console.log(`${id.padEnd(17)} ${text}`);
        return 0;
    }
    if (flags.has("--self-test")) return selfTest();
    if (flags.has("--contrast")) return printContrast();

    const args = argv.filter((a) => !a.startsWith("--"));
    const files = args.length
        ? args.map((a) => path.resolve(process.cwd(), a))
        : SCAN_DIRS.filter((d) => existsSync(path.join(CLIENT, d))).flatMap((d) => walk(path.join(CLIENT, d), []));
    const allow = loadAllowlist();
    const rel = (f) => path.relative(CLIENT, f).split(path.sep).join("/");

    let errors = 0;
    let suppressed = 0;
    const perFile = new Map();
    const seenRules = new Map();
    for (const file of files.sort()) {
        const name = rel(file);
        const findings = lintText(name, readFileSync(file, "utf8"));
        if (name === TOKENS_FILE) {
            for (const c of contrastChecks(readFileSync(file, "utf8"))) {
                if (c.kind === "required" && !c.ok) {
                    findings.push({ line: 1, rule: "contrast", message: `${c.fg} on ${c.bg} is ${c.ratio.toFixed(2)}:1, below ${c.min}:1 (${c.what})` });
                }
            }
        }
        const entry = allow[name];
        const allowed = entry ? (entry.rules === "*" ? ["*"] : entry.rules || []) : [];
        const rules = new Set();
        let fileErrors = 0;
        let fileSuppressed = 0;
        for (const f of findings) {
            rules.add(f.rule);
            const isAllowed = allowed.includes("*") || allowed.includes(f.rule);
            if (isAllowed) {
                fileSuppressed++;
                if (flags.has("--verbose")) console.log(`${name}:${f.line}  (allowed) ${f.rule}  ${f.message}`);
            } else {
                fileErrors++;
                console.log(`${name}:${f.line}  ${f.rule}  ${f.message}`);
            }
        }
        seenRules.set(name, rules);
        errors += fileErrors;
        suppressed += fileSuppressed;
        if (findings.length) perFile.set(name, { errors: fileErrors, suppressed: fileSuppressed, rules: [...rules].sort() });
    }

    let stale = 0;
    for (const [name, entry] of Object.entries(allow)) {
        if (args.length && !seenRules.has(name)) continue;
        if (!existsSync(path.join(CLIENT, name))) {
            console.log(`${ALLOW_FILE}: stale entry, ${name} no longer exists`);
            stale++;
            continue;
        }
        if (entry.rules === "*") continue;
        const seen = seenRules.get(name) || new Set();
        const unused = (entry.rules || []).filter((r) => r !== "*" && !seen.has(r));
        if (unused.length) {
            console.log(`${ALLOW_FILE}: stale rules for ${name}: ${unused.join(", ")} (no longer broken; remove them)`);
            stale++;
        }
    }

    if (flags.has("--summary")) {
        console.log("\nPer file (errors / allowlisted, rules):");
        for (const [name, s] of perFile) console.log(`  ${name}  ${s.errors} / ${s.suppressed}  ${s.rules.join(", ")}`);
    }
    const advisories = existsSync(path.join(CLIENT, TOKENS_FILE))
        ? contrastChecks(readFileSync(path.join(CLIENT, TOKENS_FILE), "utf8")).filter((c) => c.kind === "advisory" && !c.ok).length
        : 0;
    const legacy = [...perFile.values()].filter((s) => s.suppressed > 0).length;
    console.log(
        `lint-css: ${files.length} files, ${errors} finding${errors === 1 ? "" : "s"}, ` +
            `${suppressed} allowlisted in ${legacy} legacy file${legacy === 1 ? "" : "s"}` +
            (stale ? `, ${stale} stale allowlist entr${stale === 1 ? "y" : "ies"}` : "") +
            (advisories ? `; ${advisories} advisory contrast warnings (--contrast)` : ""),
    );
    if (errors) return 1;
    if (stale && flags.has("--strict")) return 1;
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`lint-css: ${err.message}`);
        process.exitCode = 2;
    }
}
