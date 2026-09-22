# Metropolis backend

One Fastify service provides wallet login, a deterministic agent qualification
runner, a signed-transaction relay, finalized chain activity, and a recovery
keeper. PostgreSQL stores authorization, runs, immutable result evidence, and the
transaction journal. It targets one configured vault on Monad Testnet (10143).

## Run and verify

From the repository root, with Node 22+, pnpm and Foundry installed:

```bash
pnpm install --frozen-lockfile
export PATH="$HOME/.foundry/bin:$PATH"
pnpm contracts:build
pnpm backend:check
pnpm backend:test
pnpm backend:build
```

The backend suite runs a local Anvil process automatically (override `ANVIL_BIN`
if needed). It deploys the application contracts and test identity/exchange/token
contracts, then exercises the API, evaluator publication, signed trade relay,
keeper settlement and redemption. It sends no public-network transactions. SQL
integration tests use PGlite's PostgreSQL engine; the production driver uses `pg`
and a separate PostgreSQL server.

For a configured deployment, create a PostgreSQL database and supply the variables
in `.env.example` through your environment or an ignored `.env` file. The service
applies its initial idempotent schema and binds the database to the configured
chain, vault, registry and deployment block. Reusing it for another deployment
fails rather than mixing state.

```bash
node --env-file=packages/backend/.env packages/backend/dist/src/main.js
```

The defaults bind to localhost:3001. Put a TLS reverse proxy in front of hosted
traffic. `APP_ORIGIN` must be the exact frontend origin, without a trailing slash.
CORS is limited to that origin. Requests are limited to 32 KB and 60 per minute
per IP (nonce issuance: 10 per minute). Run one API instance for this MVP; the
built-in rate limiter is process-local. A row lock serializes critical database
transitions for this single-vault workload.

`KEEPER_ENABLED=false` disables transaction preparation/broadcast and indexing;
qualification attempts still run and expire, and their publication stays queued.
Set it to `true` to run the journal, indexer and keeper every five seconds. Keeper
actions are normally scheduled at least 30 seconds apart. Budget caps are
`MAX_TX_GAS` and `MAX_FEE_PER_GAS`; estimated gas receives a 10% buffer.
`RECOVERY_CHUNK` is the maximum AUSD base units per recovery transaction.

## Signers and deployment requirements

- **Identity owner:** wallet login authorizes a qualification run for its agent.
- **Agent operator:** logs in to submit qualification actions, then signs its own
  vault trade transactions. Its key never goes to this service.
- **Evaluator:** a dedicated backend key that owns `QualificationRegistry`.
- **Keeper:** a distinct dedicated backend key for permissionless vault recovery.
- **Vault manager/depositors:** use their wallets and the contract ABI directly
  for activation, funding, pause, deposit, settlement requests and redemption.

The backend holds no manager or depositor key. Evaluator and keeper keys must be
different and are rejected as trade-relay signers. They need testnet MON for gas.
Never use the public Anvil development mnemonic outside local tests.

Build the current contract artifacts before starting. The deployed registry must
support `recordForOwner`; this atomically checks that the identity owner still
matches the owner who authorized the run. The deployed vault's `requiredSuite`
must equal the backend's `SUITE_HASH`. Startup verifies the suite, evaluator role,
chain ID, and code presence at each configured/discovered contract address.

Print the required suite hash without starting the service:

```bash
pnpm --filter @metropolis/backend exec tsx -e 'import { SUITE_HASH } from "./src/qualification.ts"; console.log(SUITE_HASH)'
```

Application contracts are deployed on public testnet. The API was run locally
with PostgreSQL 17.10 and successfully qualified/published the real ERC-8004 agent.
See [deployment records](../../deployments/README.md). Public API hosting remains
pending. The earlier custody-spike deployment is a separate integration.

## API

Amounts from chain state are decimal strings in native units. AUSD has six
asset decimals; vault shares have twelve decimals. Agent IDs are decimal strings.
Bearer tokens expire after one hour; challenges expire after five minutes.

| Method and route | Authorization and result |
| --- | --- |
| `GET /health` | Database liveness |
| `GET /ready` | Fresh finalized chain state |
| `GET /v1/qualification-suite` | Public scenarios, policy and suite hash |
| `POST /v1/auth/nonce` | `{address}` -> exact SIWE message and nonce |
| `POST /v1/auth/verify` | `{nonce,signature}` -> bearer token |
| `GET /v1/agents/:agentId/status` | Identity owner; recent attempts |
| `POST /v1/agents/:agentId/qualification-runs` | Identity owner; `{operator,publish:true}` |
| `GET /v1/qualification-runs/:id/observation` | Run owner/operator; current observation, result, publication state |
| `POST /v1/qualification-runs/:id/actions` | Run operator; `{step,action}` |
| `GET /v1/vaults/:vaultId/state` | Public finalized balances, positions, risk and lifecycle |
| `GET /v1/vaults/:vaultId/activity` | Last 100 indexed on-chain events |
| `GET /v1/vaults/:vaultId/keeper` | Last keeper operation and indexing cursor |
| `POST /v1/vaults/:vaultId/trade-intents` | Active operator; `{idempotencyKey,signedTransaction}` |
| `GET /v1/trade-intents/:key` | Submitting operator; transaction status and hash |

Sign the exact server-provided SIWE message. The server verifies that exact stored
message and atomically consumes the challenge. Session tokens are stored only as
SHA-256 hashes. The current signature schema accepts 65-byte EOA signatures.
Every protected request uses `Authorization: Bearer <token>`.

No manager mutation or order-cancellation HTTP routes exist. Manager actions are
wallet transactions. The vault admits IOC orders only, so there is no resting
order API to expose.

Example qualification action:

```json
{"step":0,"action":{"kind":"target","targetBps":1000}}
```

This requests 10% long exposure in the replay; negative basis points request
short exposure. `{"kind":"hold"}` keeps the current position. Target zero closes
it, and a smaller absolute target reduces it. A retry with identical step/action
returns the recorded result; different content at the same step returns 409.

## Qualification semantics

The versioned public suite contains trend, chop and crash/recovery scenarios.
Each starts with 1,000 virtual AUSD, charges 4 basis points per traded notional,
and uses integer quantity/collateral accounting. Limits are 25% equity per order,
100% absolute exposure in the one-market replay, and 10% maximum drawdown. Each
scenario needs voluntary trading activity; the aggregate return floor is -5%.
Positions are closed, with a fee, at each scenario's end.

The reference policy targets 10% long on the first step of each scenario and then
holds. It demonstrates protocol integration. The suite measures bounded behavior
on **public deterministic exercises**, not hidden-scenario generalization or
future profitability. It is not a trading-performance endorsement.

Runs expire after 15 minutes. Passes, failures, and timeouts are persisted;
timeouts publish a non-passing result. Only the identity owner can start a run
and must explicitly consent to publication. Only the bound operator can act.
A new run is blocked while that agent has an active run or unresolved publication.
Evidence includes the subject, owner, operator, suite, actions, timestamps and
result. Canonical sorted-key JSON preserves its hash through PostgreSQL JSONB
round trips. The registry receives the evidence hash; evidence remains in this
database, with no IPFS permanence claim. ERC-8004 Reputation feedback is not yet
implemented; identity binding and the application qualification registry are wired.

Run the reference client after configuring the service and registering an agent:

```bash
# Supply AGENT_ID, AGENT_OWNER_PRIVATE_KEY, AGENT_OPERATOR_PRIVATE_KEY,
# APP_ORIGIN and optionally BACKEND_URL through the process environment.
pnpm --filter @metropolis/backend reference-agent
```

The client verifies the challenge domain, URI, chain and address before signing.
It prints the result and publication state, never keys or bearer tokens. A passed
replay with `publication.status=queued` is not yet an on-chain qualification.

## Trade relay and recovery

The agent signs an EIP-1559 transaction targeting this vault's `executeTrade`.
Use the actual chain nonce, contract `nextOrderId`, bounded gas and a short order
block deadline. The server recovers the signer, checks the chain, destination,
method, active operator, nonce, zero native value and budget caps, then simulates
the call. Contract simulation enforces the current on-chain risk rules. It does
not use client-provided balances or an eventually consistent event cache for risk.

Signed bytes and their deterministic transaction hash are committed **before**
broadcast. A unique signer/nonce and one unresolved transaction per signer prevent
concurrent duplication. Timeouts retry those same bytes. Transactions are marked
confirmed/reverted only after a canonical finalized receipt. A mined IOC request
can have a partial fill or no fill; its success is not proof of a full fill.
Reconciled Perpl events and current positions provide the fill evidence.

If the nonce is consumed but the expected receipt is unavailable, the signer lane
stays blocked with `NONCE_CONSUMED_RECONCILIATION_REQUIRED`. Investigate the chain
receipt before any manual repair. The service never manufactures a replacement
order or silently resets a nonce. Frozen fees may need operator intervention;
automatic fee-bumped transaction replacement is intentionally absent.

The keeper checkpoints Trading state. In Settling it closes open positions,
recovers collateral in bounded chunks, then finalizes. It has no start-trading,
activation or withdrawal-to-arbitrary-recipient path. It revalidates queued actions
and discards stale actions if another caller already performed them. Simulation
failures stay queued; stale ownership/expired qualification requires a new run.
RPC failure, stale marks or venue withdrawal limits may delay recovery.

Finalized indexing starts at `DEPLOYMENT_BLOCK`, in batches of 100 blocks. Vault,
adapter and registry logs identify relevant receipts; Perpl events in those
receipts are decoded and deduplicated by block hash, transaction hash and log
index. Unknown events retain raw topics/data. Cursor and events commit atomically.
A changed finalized cursor hash stops the worker for investigation. RPC starts are limited to five per second per service instance to respect the
public endpoint budget. State reads
are pinned to one finalized block; activity can lag during backfill. Backend
restarts resume the durable journal and cursor rather than trusting memory.

## Verification boundary

The suite tests scenario math, SIWE replay/expiry, ownership, action concurrency,
JSONB evidence hashes, timeouts, idempotency, ambiguous submission, consumed
nonces, reverted receipts, event deduplication, finalized cursor mismatch, and
keeper progression. The local EVM integration uses the real application bytecode
and actual signatures/RPCs with test venue and identity contracts.

The separate contract fork suite exercises deployed Perpl bytecode. Still pending:
a public Perpl trade through the new vault and keeper recovery, hosted PostgreSQL
verification, public API hosting, and frontend wiring. Real ERC-8004 enrollment,
publication, and local PostgreSQL operation against public testnet are verified.
