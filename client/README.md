# Instructions to run

Refer [here](../setup/readme.md) to set up the development environment required for the client.


## Tests

Run the default mocked Playwright tests with:

```bash
npm test
```

Run the opt-in full-stack suite against already running real services with:

```bash
E2E_FULL_STACK=1 E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e
```

See `../docs/responsive-and-e2e.md` for setup details and Chrome CDP visual probes.
