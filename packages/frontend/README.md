# Frontend

The Metropolis frontend is a React, TypeScript, Vite and viem application for
Monad Testnet. It reads live vault state, indexed events and registry
qualification. It uses the working callsign `VOID JACKAL` for the registered
agent; the numeric ERC-8004 ID remains visible only as an on-chain identifier.

## Run locally

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm frontend:dev
```

Open `http://localhost:3000`, exactly. The hosted API permits that origin for
browser requests. `http://127.0.0.1:3000` is a different origin and will fail
CORS. No environment file is required for the deployed testnet setup.
Copy `.env.example` to `.env.local` only to override the public API or RPC URLs.

```bash
pnpm frontend:check
pnpm frontend:build
```

## Live paths

- Public reads: vault lifecycle, assets, shares, positions, risk availability,
  qualification status and expiry, finalized event history and keeper cursor.
- Connected wallet: AUSD balance and allowance, share balance and account role.
  Deposits approve only the requested AUSD amount before depositing, and both
  deposit and redemption set a minimum output at 99.5% of the on-chain quote.
- Vault manager: agent activation, trading allocation, pause and resume.
  Shareholders and the manager can request settlement while trading.
- Qualification: the identity owner creates a time-limited run. The registered
  operator can submit the public deterministic reference policy. The backend
  publishes the result; the UI reads the registry for the authoritative status.

Wallet actions require an EIP-1193 wallet that supports Monad Testnet (chain ID
10143). The connector discovers multiple injected wallets through EIP-6963 and
offers a chooser; `window.ethereum` remains a fallback for older wallets. The
qualification operator is a separate address from the
vault manager. Authentication uses the API's SIWE challenge; its signature does
not authorize token transfers. The bearer token is kept in memory and is
discarded on reload or account change. Transactions require explicit wallet
confirmation and are checked for a successful receipt before the UI reports
confirmation.

The frontend does not create or sign Perpl IOC orders. A trading agent supplies
its signed order through the backend relay; the vault and risk controller remain
the admission authority. The interface never substitutes mock positions or
performance for missing live data.

## Hosting

The static testnet site is published by direct upload to Cloudflare Pages at
`https://metropolis-vault-testnet.pages.dev`. Build output is
`packages/frontend/dist`. The Pages project is named `metropolis-vault-testnet`;
its `wrangler.jsonc` config points to `dist`. From this package directory, use
`pnpm build` followed by `npx wrangler pages deploy dist --branch=main` for a
new production deployment. Direct Upload projects do not support later switching
to Git integration; use a new Pages project if automatic Git builds are needed.
If Wrangler has access to multiple Cloudflare accounts, set
`CLOUDFLARE_ACCOUNT_ID` to the intended account before deploying. Keep account
selection and authentication outside the repository.

Set `VITE_API_URL` and `VITE_RPC_URL` at build time when using other endpoints.
The backend `APP_ORIGIN` must be the public Pages origin; localhost is included
through `APP_ADDITIONAL_ORIGINS`. `VITE_` variables are public browser
configuration and must not contain secrets.
