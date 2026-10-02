#!/usr/bin/env node
/**
 * CSS lint for the board redesign. No dependencies. See docs/ui/foundations.md.
 *
 *   node tools/lint-css.mjs              lint src/ and public/: CSS files, .astro <style>
 *                                        blocks, static style attributes, viewport metas
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
// The self-test fixtures embed markup full of double quotes.
/* eslint quotes: ["error", "double", { "avoidEscape": true }] */
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
    "safe-area": "No env(safe-area-inset-*), nor the old constant() form, outside tokens.css; use var(--sp-safe-t/r/b/l).",
    "background-fixed": "No background-attachment: fixed; draw a position: fixed ::before layer instead.",
    "root-overflow": "No overflow-x: hidden or clip (nor overflow: hidden or clip) on html, :root or body.",
    "fixed-ancestor":
        "html, body, #game-elements, .board-container and #board never get transform, translate, rotate, " +
        "scale, transform-style, offset-path, filter, backdrop-filter, perspective, contain, will-change, " +
        "container or content-visibility, nor an animation whose @keyframes set one, which would capture " +
        "their position: fixed descendants.",
    "hover-media": `:hover rules (also inside :is(), :where() or :not()) sit inside @media ${MEDIA.hover}; nothing depends on hover.`,
    "font-family": "font-family and the font shorthand use var(--sp-font-*), with no fallback after it.",
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
        // An unquoted url(...) is one token: "/*" or ";" inside it is not a comment or an end.
        if ((ch === "u" || ch === "U") && /^url\(\s*[^\s"')]/i.test(css.slice(i, i + 6)) && !/[\w-]/.test(css[i - 1] || "")) {
            const end = css.indexOf(")", i);
            if (end > 0) {
                append(css.slice(i, end + 1));
                line += countNewlines(css.slice(i, end + 1));
                i = end + 1;
                continue;
            }
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

/**
 * Replace the insides of strings, () and [] with "_" so only the outer
 * structure remains. The result has the same length (in UTF-16 code units),
 * so an index into it is an index into the input.
 */
function maskNested(s) {
    let out = "";
    let depth = 0;
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
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

/**
 * Replace the insides of strings and [] with "_", keeping () contents, so
 * pseudo-classes inside :is(), :where() and :not() stay visible.
 */
function maskStringsAndAttrs(s) {
    let out = "";
    let depth = 0;
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            out += "_";
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            out += "_";
        } else if (ch === "[") {
            out += depth === 0 ? ch : "_";
            depth++;
        } else if (ch === "]") {
            depth = Math.max(0, depth - 1);
            out += depth === 0 ? ch : "_";
        } else {
            out += depth > 0 ? "_" : ch;
        }
    }
    return out;
}

const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)(?![\w-])/i;
// Functional pseudo-classes that match their argument itself, so their
// argument's subject is the compound's subject. :not() and :has() are not.
const MATCHES_ARGUMENT = /:(is|where|matches|-webkit-any|-moz-any)\(/gi;

/**
 * Which protected element a selector's subject (its last compound) targets:
 * "html", "body", ":root", "#board", ... or null. Pseudo-elements are not
 * the element itself, so body::before is not body. :where(body) and
 * :is(html, .x) are body and html.
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
        // maskNested keeps each character's position, so the raw argument is
        // the same slice of the unmasked compound.
        const raw = complex.slice(k + 1);
        for (const m of compound.matchAll(MATCHES_ARGUMENT)) {
            const open = m.index + m[0].length - 1;
            const close = compound.indexOf(")", open + 1);
            if (close > open) hits.push(...protectedSubjects(raw.slice(open + 1, close)));
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
// The family is the last part of the font shorthand, so nothing may follow the token.
const FONT_SHORTHAND_OK = /var\(--sp-font-[\w-]+\)\s*$/i;
const VH_100 = /(?<![\w.-])100(?:d|s|l)?vh(?![\w-])/i;
// constant() is the iOS 11.0 spelling of env().
const SAFE_ENV = /\b(?:env|constant)\(\s*safe-area-inset-/i;
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
    "transform-style": "flat",
    "-webkit-transform-style": "flat",
    "offset-path": "none",
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

/** The capturing property a declaration sets, or null when its value is the neutral one. */
function capturingProp(prop, value) {
    if (!(prop in FIXED_ANCESTOR_PROPS)) return null;
    const v = value.trim().toLowerCase();
    return v === FIXED_ANCESTOR_PROPS[prop] || FONT_KEYWORD.test(v) ? null : prop;
}

const ANIMATION_PROPS = new Set(["animation", "-webkit-animation", "animation-name", "-webkit-animation-name"]);
const ANIMATION_KEYWORDS = new Set([
    "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards", "backwards", "both",
    "running", "paused", "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end", "auto",
    ...KEYWORDS.split("|"),
]);

/** The @keyframes names an animation or animation-name value refers to. */
function animationNames(prop, value) {
    const names = [];
    for (const layer of splitTopLevel(value)) {
        if (prop.endsWith("animation-name")) {
            names.push(layer.replace(/^["']|["']$/g, ""));
            continue;
        }
        // Drop functions (cubic-bezier(), steps(), var()), then times, numbers and keywords.
        for (const tok of layer.replace(/[\w-]+\([^()]*\)/g, " ").split(/\s+/)) {
            if (!tok || /^[-+]?[\d.]+(m?s)?$/i.test(tok) || ANIMATION_KEYWORDS.has(tok.toLowerCase())) continue;
            names.push(tok.replace(/^["']|["']$/g, ""));
        }
    }
    return names.filter((n) => n && n.toLowerCase() !== "none");
}

/**
 * For each @keyframes block in some CSS, the capturing properties it
 * animates: Map name -> [prop, ...] (only names that animate at least one).
 */
export function keyframeCaptures(css) {
    const out = new Map();
    const visit = (nodes) => {
        for (const node of nodes) {
            if (node.type === "at" && /keyframes$/.test(node.name) && node.children) {
                const props = new Set();
                for (const frame of node.children) {
                    for (const d of frame.children || []) if (d.type === "decl" && capturingProp(d.prop, d.value)) props.add(d.prop);
                }
                if (props.size) out.set(node.prelude.replace(/^["']|["']$/g, ""), [...props]);
            } else if (node.children) {
                visit(node.children);
            }
        }
    };
    visit(parseCss(css).root.children);
    return out;
}

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

/** The media query list of an @import prelude, after its URL, layer and supports(). */
function importMedia(prelude) {
    return prelude
        .replace(/^\s*(url\([^)]*\)|"[^"]*"|'[^']*')/i, "")
        .replace(/\b(layer|supports)\([^)]*\)/gi, "")
        .replace(/^\s*layer\b/i, "")
        .trim();
}

function lintTree(root, ctx, add) {
    const visit = (nodes, ancestors) => {
        for (const node of nodes) {
            const styleAncestor = ancestors.some((a) => a.type === "rule");
            if (node.type === "at") {
                if (node.name === "layer") add(node.line, "at-layer", `@layer ${node.prelude}`.trim());
                if (node.name === "import" && /\blayer\b/i.test(node.prelude)) add(node.line, "at-layer", "@import into a layer");
                if (node.name === "nest") add(node.line, "nesting", "@nest");
                else if (styleAncestor && node.children) add(node.line, "nesting", `@${node.name} nested inside a style rule`);
                if (node.name === "media") for (const [rule, msg] of mediaFindings(node.prelude)) add(node.line, rule, msg);
                if (node.name === "import" && importMedia(node.prelude)) {
                    for (const [rule, msg] of mediaFindings(importMedia(node.prelude))) add(node.line, rule, msg);
                }
            } else if (node.type === "rule") {
                // Strings and attribute values hidden; :is()/:where()/:not() arguments kept.
                const plain = maskStringsAndAttrs(node.selector);
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
                    lintDecl(node, parent.selector, ctx, add);
                }
                // Declarations directly in an at-rule are descriptors (@font-face, @page, @property).
            }
            if (node.children) visit(node.children, [...ancestors, node]);
        }
    };
    visit(root.children, []);
}

function lintDecl(decl, selector, { isTokens, keyframes }, add) {
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
    if (prop === "font" && !FONT_KEYWORD.test(value) && !FONT_SHORTHAND_OK.test(value)) add(line, "font-family", `font: ${value}`);

    const subjects = protectedSubjects(selector);
    if (!subjects.length) return;
    const roots = subjects.filter((s) => s === "html" || s === "body" || s === ":root");
    if (roots.length) {
        const first = value.trim().split(/\s+/)[0].toLowerCase();
        if ((prop === "overflow-x" || prop === "overflow") && (first === "hidden" || first === "clip")) {
            add(line, "root-overflow", `${prop}: ${value} on ${roots.join(", ")}`);
        }
    }
    if (capturingProp(prop, value)) add(line, "fixed-ancestor", `${prop}: ${value} on ${subjects.join(", ")}`);
    // A running animation of a capturing property captures as well. Keyframes
    // are looked up in the same file first, then in every scanned file.
    if (ANIMATION_PROPS.has(prop)) {
        for (const name of animationNames(prop, value)) {
            const props = keyframes.get(name);
            if (props) add(line, "fixed-ancestor", `${prop}: ${value} on ${subjects.join(", ")} animates ${props.join(", ")} (@keyframes ${name})`);
        }
    }
}

// ---------------------------------------------------------------------------
// Files: CSS, and .astro/.html (style blocks, style attributes, viewport metas).

const lineAt = (text, index) => 1 + countNewlines(text.slice(0, index));

export function lintCss(css, { isTokens = false, firstLine = 1, keyframes = new Map() } = {}) {
    const findings = [];
    const add = (line, rule, message) => findings.push({ line, rule, message: message.replace(/\s+/g, " ") });
    const { root, errors } = parseCss(css, firstLine);
    for (const e of errors) add(e.line, "parse", e.message);
    const all = new Map([...keyframes, ...keyframeCaptures(css)]);
    lintTree(root, { isTokens, keyframes: all }, add);
    return findings;
}

/** Index of the quote closing the JS string that opens at `i`, or -1. */
function skipJsString(text, i) {
    const q = text[i];
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === q) return j;
        else if (text[j] === "\n") return -1;
    }
    return -1;
}

/** Index of the backtick closing the template literal that opens at `i`, or -1. */
function skipTemplate(text, i) {
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === "`") return j;
        else if (text[j] === "$" && text[j + 1] === "{") {
            const end = skipBraces(text, j + 1);
            if (end < 0) return -1;
            j = end - 1;
        }
    }
    return -1;
}

/** Index just past the "}" matching the "{" at `i`, skipping JS strings and template literals, or -1. */
function skipBraces(text, i) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (ch === '"' || ch === "'") j = skipJsString(text, j);
        else if (ch === "`") j = skipTemplate(text, j);
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return j + 1;
        if (j < 0) return -1;
    }
    return -1;
}

/**
 * The attributes of a start tag whose name ends at `j`, up to its closing
 * ">" or "/>". A ">" inside a quoted value or a {...} expression does not
 * close the tag. Returns null when this is not a tag after all (an
 * unquoted "<" first, or no end).
 */
function parseTag(text, j) {
    const attrs = new Map();
    while (j < text.length) {
        const ch = text[j];
        if (/\s/.test(ch)) {
            j++;
        } else if (ch === ">") {
            return { attrs, end: j + 1, selfClosing: false };
        } else if (ch === "/" && text[j + 1] === ">") {
            return { attrs, end: j + 2, selfClosing: true };
        } else if (ch === "<") {
            return null;
        } else if (ch === "{") {
            j = skipBraces(text, j); // {...spread} or a bare expression
            if (j < 0) return null;
        } else {
            const nm = /^[^\s=>/<{"'`]+/.exec(text.slice(j, j + 200));
            if (!nm) {
                j++; // a stray quote or slash
                continue;
            }
            const name = nm[0].toLowerCase();
            j += nm[0].length;
            let k = j;
            while (/\s/.test(text[k] || "")) k++;
            if (text[k] !== "=") {
                attrs.set(name, { kind: "bare", value: "" });
                continue;
            }
            k++;
            while (/\s/.test(text[k] || "")) k++;
            const q = text[k];
            if (q === '"' || q === "'") {
                const close = text.indexOf(q, k + 1);
                if (close < 0) return null;
                attrs.set(name, { kind: "quoted", value: text.slice(k + 1, close) });
                j = close + 1;
            } else if (q === "{") {
                const end = skipBraces(text, k);
                if (end < 0) return null;
                attrs.set(name, { kind: "expression", value: text.slice(k + 1, end - 1) });
                j = end;
            } else if (q === "`") {
                const close = skipTemplate(text, k);
                if (close < 0) return null;
                attrs.set(name, { kind: "template", value: text.slice(k + 1, close) });
                j = close + 1;
            } else {
                const v = /^[^\s>]*/.exec(text.slice(k, k + 2000))[0];
                attrs.set(name, { kind: "unquoted", value: v });
                j = k + v.length;
            }
        }
    }
    return null;
}

/**
 * Every start tag of an .astro or .html file, skipping the Astro
 * frontmatter, comments and the contents of <script> and <style> (a
 * <style> tag's text comes back as `content`).
 */
export function* scanTags(text, { astro = false } = {}) {
    let i = 0;
    const frontmatter = astro ? /^\s*---[^\S\n]*\n[\s\S]*?\n---/.exec(text) : null;
    if (frontmatter) i = frontmatter[0].length;
    const lower = text.toLowerCase();
    while (i < text.length) {
        const lt = text.indexOf("<", i);
        if (lt < 0) return;
        if (text.startsWith("<!--", lt)) {
            const end = text.indexOf("-->", lt + 4);
            i = end < 0 ? text.length : end + 3;
            continue;
        }
        const nm = /^<([a-zA-Z][\w:.-]*)/.exec(text.slice(lt, lt + 100));
        const parsed = nm && parseTag(text, lt + nm[0].length);
        if (!parsed) {
            i = lt + 1;
            continue;
        }
        const tag = nm[1].toLowerCase();
        let content = null;
        i = parsed.end;
        if ((tag === "script" || tag === "style") && !parsed.selfClosing) {
            const close = lower.indexOf(`</${tag}`, i);
            const stop = close < 0 ? text.length : close;
            content = { start: i, text: text.slice(i, stop) };
            i = stop;
        }
        yield { tag, attrs: parsed.attrs, index: lt, content };
    }
}

/** An attribute's value when it is static text: quoted, unquoted, or a {"string literal"}; else null. */
function staticValue(attr) {
    if (!attr) return null;
    if (attr.kind === "quoted" || attr.kind === "unquoted") return attr.value;
    if (attr.kind === "template") return attr.value.includes("${") ? null : attr.value;
    if (attr.kind === "expression") {
        const lit = /^\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*$/.exec(attr.value);
        return lit ? lit[2] : null;
    }
    return null;
}

const PREPROCESSED = /^(scss|sass|less|stylus|styl)$/i;

/** The style blocks of a markup file that hold plain CSS. */
const styleBlocks = (tags) => tags.filter((t) => t.tag === "style" && t.content && !PREPROCESSED.test(staticValue(t.attrs.get("lang")) || ""));

function lintMarkup(text, rel, globalKeyframes) {
    const findings = [];
    let viewportMetas = 0;
    const tags = [...scanTags(text, { astro: rel.endsWith(".astro") })];
    const blocks = styleBlocks(tags);
    const keyframes = new Map(globalKeyframes);
    for (const b of blocks) for (const [name, props] of keyframeCaptures(b.content.text)) keyframes.set(name, props);
    for (const b of blocks) findings.push(...lintCss(b.content.text, { firstLine: lineAt(text, b.content.start), keyframes }));
    for (const t of tags) {
        const line = lineAt(text, t.index);
        if (t.tag === "meta" && (staticValue(t.attrs.get("name")) || "").toLowerCase() === "viewport") {
            viewportMetas++;
            const content = staticValue(t.attrs.get("content"));
            const got = content ? content.split(",").map((s) => s.trim()).filter(Boolean).join(", ") : "";
            if (got !== VIEWPORT_META) {
                findings.push({ line, rule: "viewport-meta", message: `viewport is "${content ?? ""}"` });
            }
        }
        const style = staticValue(t.attrs.get("style"));
        if (style === null || /\{/.test(style)) continue;
        const id = staticValue(t.attrs.get("id"));
        const classes = staticValue(t.attrs.get("class"));
        const selector =
            t.tag +
            (id && /^[\w-]+$/.test(id) ? `#${id}` : "") +
            (classes && !/[{}]/.test(classes) ? classes.trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join("") : "");
        for (const f of lintCss(`${selector}{${style}}`, { firstLine: line, keyframes })) {
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

/** The keyframe captures of one file of any kind the lint reads. */
export function fileKeyframes(file, text) {
    const rel = file.split(path.sep).join("/");
    if (rel.endsWith(".css")) return keyframeCaptures(text);
    const out = new Map();
    if (rel.endsWith(".astro") || rel.endsWith(".html")) {
        for (const b of styleBlocks([...scanTags(text, { astro: rel.endsWith(".astro") })])) {
            for (const [name, props] of keyframeCaptures(b.content.text)) out.set(name, props);
        }
    }
    return out;
}

/**
 * Lint one file's text. `file` is the path relative to client/, used for the
 * tokens.css exemption. `keyframes` holds the keyframe captures of the other
 * files (see fileKeyframes), so an animation defined elsewhere is checked too.
 */
export function lintText(file, text, { keyframes = new Map() } = {}) {
    const rel = file.split(path.sep).join("/");
    if (rel.endsWith(".css")) return lintCss(text, { isTokens: rel === TOKENS_FILE || rel.endsWith("/" + TOKENS_FILE), keyframes });
    if (rel.endsWith(".astro") || rel.endsWith(".html")) return lintMarkup(text, rel, keyframes);
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
        name: "style attribute after an arrow-function attribute",
        file: "src/x.astro",
        css: '<button onClick={() => go()} style="z-index: 5"></button>\n',
        expect: ["z-index"],
    },
    { name: "style attribute after a quoted >", file: "src/x.astro", css: '<div data-x="a>b" style="z-index: 5"></div>\n', expect: ["z-index"] },
    {
        name: "single-quoted style attribute",
        file: "src/x.html",
        css: "<div style='z-index: 5; height: 100vh'></div>\n",
        expect: ["z-index", "viewport-height"],
    },
    {
        name: "string-literal style expression",
        file: "src/x.astro",
        css: '<div id="board" style={"transform: scale(2)"}></div>\n',
        expect: ["fixed-ancestor"],
    },
    {
        name: "frontmatter, text and scripts are not markup",
        file: "src/x.astro",
        css:
            "---\nconst xs: Array<string> = ['<div style=\"z-index: 5\">'];\nconst big = 2 > 1;\n---\n<p>{a<b}</p>\n" +
            "<script>const s = '<div style=\"z-index: 5\">';</script>\n<div style=\"height: 100vh\"></div>\n",
        expect: ["viewport-height"],
        lines: { "viewport-height": 7 },
    },
    {
        name: "an unquoted < ends a false tag, so the real tag after it is seen",
        file: "src/x.astro",
        css: '<p>{a<b} <meta name="viewport" content="width=device-width"></p>\n',
        expect: ["viewport-meta"],
    },
    { name: ":hover inside :is()", file: "src/x.css", css: ".a:is(:hover, :focus-visible) { color: red; }", expect: ["hover-media"] },
    {
        name: ":where(body) and :is(.x, #board) are protected",
        file: "src/x.css",
        css: ":where(body) { overflow-x: hidden; } :is(.x, #board) { transform: scale(1.01); }",
        expect: ["root-overflow", "fixed-ancestor"],
    },
    {
        name: ":not(body) and .x:has(#board) are not",
        file: "src/x.css",
        css: "div:not(body) { overflow-x: hidden; } .x:has(#board) { transform: scale(1.01); }",
        expect: [],
    },
    {
        name: "animation of a transform on #board",
        file: "src/x.css",
        css: "#board { animation: wobble 1s ease-in-out infinite; } @keyframes wobble { to { transform: rotate(1deg); } }",
        expect: ["fixed-ancestor"],
    },
    {
        name: "animation with its keyframes in another file",
        file: "src/x.css",
        css: "body { animation-name: drift; }",
        others: { "src/k.astro": "<style>\n@keyframes drift { from { filter: blur(1px); } }\n</style>\n" },
        expect: ["fixed-ancestor"],
    },
    { name: "body transform-style: preserve-3d", file: "src/x.css", css: "body { transform-style: preserve-3d; }", expect: ["fixed-ancestor"] },
    { name: "#board offset-path", file: "src/x.css", css: '#board { offset-path: path("M0 0 L10 0"); }', expect: ["fixed-ancestor"] },
    {
        name: "constant(safe-area-inset-bottom)",
        file: "src/x.css",
        css: ".a { padding-bottom: constant(safe-area-inset-bottom); }",
        expect: ["safe-area"],
    },
    { name: "font shorthand with a raw fallback", file: "src/x.css", css: ".a { font: 600 12px/1 var(--sp-font-ui), Arial; }", expect: ["font-family"] },
    { name: "@import with a range media query", file: "src/x.css", css: '@import url("a.css") (width <= 700px);', expect: ["media-range"] },
    {
        name: "clean markup with expressions",
        file: "src/x.astro",
        css:
            '---\nconst open = true;\n---\n<div class="a" onClick={() => (open ? "x>y" : `${open}>`)} {...rest}\n' +
            '  style="z-index: var(--z-sheet); height: var(--sp-vh)" style2={{ zIndex: 5 }}></div>\n',
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
            "body { animation: fade-in 200ms ease-out both; } @keyframes fade-in { from { opacity: 0; } }",
            ".d { background: url(/img/*x.png) no-repeat; }",
            '@import url("print.css") print;',
            ".e:not(:focus) { color: red; }",
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
        const keyframes = new Map();
        for (const [file, text] of Object.entries(fx.others || {})) for (const [k, v] of fileKeyframes(file, text)) keyframes.set(k, v);
        const findings = lintText(fx.file, fx.css, { keyframes });
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
    // Keyframes from the whole tree, so an animation on a protected element
    // is checked even when its @keyframes live in another file.
    const keyframes = new Map();
    const tree = SCAN_DIRS.filter((d) => existsSync(path.join(CLIENT, d))).flatMap((d) => walk(path.join(CLIENT, d), []));
    for (const file of new Set([...tree, ...files])) {
        for (const [name, props] of fileKeyframes(rel(file), readFileSync(file, "utf8"))) keyframes.set(name, props);
    }

    let errors = 0;
    let suppressed = 0;
    const perFile = new Map();
    const seenRules = new Map();
    for (const file of files.sort()) {
        const name = rel(file);
        const findings = lintText(name, readFileSync(file, "utf8"), { keyframes });
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
