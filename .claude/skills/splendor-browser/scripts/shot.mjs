#!/usr/bin/env node
// @ts-check
/**
 * Screenshot (and probe) the Splendor client as one or more players, at real
 * mobile and desktop viewports, in a private headless Chrome.
 *
 *   node shot.mjs --identities=FILE --as=p1,p2 --vp=phone,landscape,desktop [--full] [--assert=all]
 *   node shot.mjs --identities=FILE --as=all --matrix
 *   node shot.mjs --instance=cdp --as=anon --page=login --vp=se
 *
 * Writes <who>-<viewport>.png and manifest.json (probe results, console
 * errors, failed requests) to --out-dir and prints one line per shot.
 * Every option is described in capture.mjs. Exit 1 when an --assert fails
 * or a shot errors, 2 on bad usage.
 */
import { run } from "./capture.mjs";

run(process.argv.slice(2), { tool: "shot.mjs", screenshots: true }).catch((err) => {
    process.stderr.write(`shot.mjs: ${err?.stack || err}\n`);
    process.exitCode = 2;
});
