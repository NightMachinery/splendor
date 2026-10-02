# Instructions to run

Refer [here](../setup/readme.md) to set up the development environment required for the client.
For a local stack (Lobby Service, Game Service and this client), use
`../self_host.py dev-start`; see [../docs/self-hosting.md](../docs/self-hosting.md).

Use pnpm for every package operation (`pnpm install`, `pnpm build`).

## Tests

All test suites are described in [../docs/testing.md](../docs/testing.md).
From this directory:

```bash
pnpm install
pnpm exec playwright install chromium webkit

pnpm run test:unit        # node:test unit tests
pnpm test                 # mocked Playwright suite (backends stubbed)
pnpm run test:e2e:fake    # full games on the real board, offline, on the fake stack
pnpm run lint:css         # CSS lint
```

Against a real stack, start an isolated instance from the repository root
(never the default instance or production) and point the tests at it:

```bash
../self_host.py instance-start e2e
E2E_INSTANCE=e2e pnpm run test:e2e:api   # whole bot games and rule probes over the APIs
E2E_INSTANCE=e2e pnpm run test:e2e:ui    # whole games watched on a desktop and a phone board
../self_host.py instance-stop e2e
```

See [../docs/responsive-and-e2e.md](../docs/responsive-and-e2e.md) for the
responsive CSS structure and the browser visual probes (the
`splendor-browser` skill).
