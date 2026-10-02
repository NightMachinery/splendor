// Static checks of the pnpm commands in the GitHub workflows, so a step that
// can never work fails here, locally, instead of on every CI run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL("../../", import.meta.url));
const workflowsDir = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const scripts = JSON.parse(readFileSync(`${clientDir}package.json`, "utf8")).scripts;

/**
 * pnpm commands that are also script names: pnpm runs the script, but parses
 * the options after the command itself, so `pnpm test --output=x` exits with
 * "Unknown options". `pnpm run test --output=x` passes them to the script.
 */
const BUILTIN_SCRIPT_COMMANDS = ["test", "start", "stop", "restart"];

/** Every pnpm command line in a workflow file, with its line number. */
function pnpmCommands(text) {
    return text.split("\n")
        .map((line, i) => ({ line: i + 1, cmd: line.replace(/^\s*(-\s*)?(run:\s*)?/, "").trim() }))
        .filter(({ cmd }) => /^pnpm\s/.test(cmd));
}

/** pnpm command lines that cannot work, as messages. Exported shape for the self-test below. */
function problems(text, file) {
    const out = [];
    for (const { line, cmd } of pnpmCommands(text)) {
        const [, sub, rest = ""] = cmd.match(/^pnpm\s+(\S+)\s*(.*)$/) ?? [];
        if (BUILTIN_SCRIPT_COMMANDS.includes(sub) && /(^|\s)-/.test(rest)) {
            out.push(`${file}:${line}: "${cmd}": pnpm parses the options of its built-in ${sub} itself; write "pnpm run ${sub} ${rest}"`);
        }
        if (sub === "run") {
            const name = rest.split(/\s+/)[0];
            if (!name || !(name in scripts)) out.push(`${file}:${line}: "${cmd}": client/package.json has no script ${JSON.stringify(name)}`);
        }
    }
    return out;
}

test("the check itself flags pnpm test with options and unknown scripts", () => {
    const sample = [
        "      - run: pnpm test --output=test-results/mocked",
        "        run: pnpm run test --output=x",
        "        run: pnpm test",
        "        run: pnpm run no-such-script",
        "        run: pnpm exec playwright test --project=mocked-mobile-webkit",
    ].join("\n");
    const found = problems(sample, "sample.yml");
    assert.equal(found.length, 2, found.join("\n"));
    assert.match(found[0], /sample\.yml:1: .*pnpm run test/);
    assert.match(found[1], /sample\.yml:4: .*no script "no-such-script"/);
});

test("every pnpm command in the workflows can run", () => {
    const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.length > 0, `no workflows in ${workflowsDir}`);
    const found = files.flatMap((f) => problems(readFileSync(`${workflowsDir}${f}`, "utf8"), `.github/workflows/${f}`));
    assert.deepEqual(found, []);
    // the Playwright steps are the ones this guards; make sure the scan sees them
    const playwright = pnpmCommands(readFileSync(`${workflowsDir}playwright.yml`, "utf8"));
    assert.ok(playwright.some(({ cmd }) => cmd.startsWith("pnpm run test ")), "playwright.yml no longer runs the mocked suite with pnpm run test");
});
