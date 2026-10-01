// Which stack the full-stack tests talk to (tests/e2e/lib/stack.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStack } from "../e2e/lib/stack.mjs";

test("no variables means no stack", () => {
    assert.equal(resolveStack({}), null);
});

test("E2E_BASE_URL alone proxies /ls and /gs", () => {
    assert.deepEqual(resolveStack({ E2E_BASE_URL: "http://127.0.0.1:4321/" }), {
        instance: null, baseUrl: "http://127.0.0.1:4321", lsUrl: "http://127.0.0.1:4321/ls", gsUrl: "http://127.0.0.1:4321/gs",
    });
});

test("E2E_INSTANCE reads instance.json; explicit URLs win field by field", () => {
    const dir = mkdtempSync(join(tmpdir(), "splendor-stack-"));
    try {
        mkdirSync(join(dir, "instances", "e2e"), { recursive: true });
        writeFileSync(join(dir, "instances", "e2e", "instance.json"), JSON.stringify({
            name: "e2e", baseUrl: "http://127.0.0.1:5000", lsUrl: "http://127.0.0.1:5001", gsUrl: "http://127.0.0.1:5002",
        }));
        const env = { E2E_INSTANCE: "e2e", E2E_SELF_HOST_DIR: dir };
        assert.deepEqual(resolveStack(env), {
            instance: "e2e", baseUrl: "http://127.0.0.1:5000", lsUrl: "http://127.0.0.1:5001", gsUrl: "http://127.0.0.1:5002",
        });
        assert.equal(resolveStack({ ...env, E2E_GS_URL: "http://localhost:6000" }).gsUrl, "http://localhost:6000");
        assert.throws(() => resolveStack({ ...env, E2E_INSTANCE: "missing" }), /does not exist/);
        assert.throws(() => resolveStack({ ...env, E2E_INSTANCE: "../etc" }), /not a valid instance name/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("non-loopback hosts are refused unless E2E_ALLOW_REMOTE=1", () => {
    assert.throws(() => resolveStack({ E2E_BASE_URL: "https://splendor.example.org" }), /Refusing to run e2e tests against non-local host/);
    assert.equal(resolveStack({ E2E_BASE_URL: "https://splendor.example.org", E2E_ALLOW_REMOTE: "1" }).lsUrl, "https://splendor.example.org/ls");
});
