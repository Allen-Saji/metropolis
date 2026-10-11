<p align="center">
  <img src="assets/metropolis-mark.svg" alt="Metropolis logo" width="112" height="112">
</p>

<h1 align="center">Metropolis</h1>

Metropolis is an AUSD vault on Monad Testnet that gives a qualified trading agent
limited access to Perpl. Depositors hold vault shares. An agent can place
immediate-or-cancel BTC or ETH orders only after a qualification is published
on-chain, and every order passes the vault's risk checks. Share conversions resume
after positions are closed and collateral has returned to the vault.

The [testnet app](https://metropolis.allensaji.dev) exposes live vault
state, wallet actions, qualification, risk policy and indexed transactions.
[Deployment records](deployments/README.md) contain contract addresses, source
verification and transaction receipts.

## How it works

1. An ERC-8004 agent's identity owner starts a qualification run. Its assigned
   operator executes a public, deterministic policy exercise. The evaluator
   records the result in `QualificationRegistry`, bound to the agent, identity
   owner, operator and suite.
2. Depositors add AUSD while the vault is Settled and receive shares. The manager
   selects a qualified agent and allocates vault collateral to its Perpl account.
3. The agent signs an IOC order. The Fastify relay checks authorization and
   transaction identity; `MetropolisVault` and `RiskController` enforce the
   trading limits on-chain. `PerplAdapter` owns the venue account. The operator
   cannot withdraw or transfer collateral.
4. The manager or any shareholder can request settlement. A keeper closes
   positions, recovers collateral and finalizes the vault. Depositors can then
   redeem shares for the assets actually available.

The vault has one active operator at a time. The fixed policy allows BTC and ETH,
caps a new order at 25% of current equity, caps aggregate exposure at 2x equity,
and blocks new exposure after a 10% observed drawdown. Stale or unavailable risk
data also blocks new exposure. See [contract design](packages/contracts/README.md)
for the full policy, accounting rules and lifecycle conditions.

## System layout

| Component | Responsibility |
| --- | --- |
| [Contracts](packages/contracts/README.md) | Shares, lifecycle, qualification gate, Perpl custody and risk enforcement |
| [Backend](packages/backend/README.md) | SIWE sessions, qualification runner, signed-order relay, finalized event indexer and recovery keeper |
| [Frontend](packages/frontend/README.md) | Live state and activity, wallet deposits and redemptions, manager controls and qualification workflow |
| PostgreSQL | Qualification evidence, sessions, transaction journal and indexed activity |

The backend holds evaluator and keeper keys. It does not hold depositor, manager or
agent operator keys. The qualification suite is public and deterministic; passing
it establishes that the operator completed these bounded exercises, not that it
will trade profitably. Trade execution and withdrawals remain subject to the
contracts even when the backend is unavailable.

## Testnet deployment

- Chain: Monad Testnet, chain ID `10143`.
- App: https://metropolis.allensaji.dev
- API: https://backend-production-e090.up.railway.app
- Contracts and receipts: [deployment records](deployments/README.md).

The [October 11 testnet run](deployments/monad-testnet-rehearsal-proof.json)
records a published qualification, 1,000 AUSD deposit, real 0.001 BTC Perpl
fill, settlement through the keeper, and 999.922797 AUSD redemption. The
oversized-order and unqualified-agent checks in that record were read-only
simulations; they were not broadcast transactions. The final recorded state has
zero shares, venue collateral and open positions. A separate Backpack browser
test completed a 1 AUSD deposit and full redemption through the hosted app.

These are testnet results, not a return forecast. The contracts have not been
audited. Venue liquidity, price data and contract availability affect execution
and settlement; there is no guaranteed settlement time. The vault is not
ERC-4626, and estimated equity during trading is not a redemption quote. Do not
use it with mainnet funds.

## Run locally

Install Node.js 22 or newer, pnpm 10.8.1 and Foundry. The frontend can use the
hosted testnet API without a local database or secret file.

```bash
pnpm install --frozen-lockfile
pnpm frontend:dev
```

Open `http://localhost:3000`. A compatible wallet must be set to Monad Testnet
for transactions. Local API setup, PostgreSQL configuration and deployment
requirements are in the [backend guide](packages/backend/README.md). The
[frontend guide](packages/frontend/README.md) documents public configuration
overrides and wallet behavior.

## Build and verify

```bash
pnpm contracts:build
pnpm contracts:test
pnpm spike:test
pnpm backend:check
pnpm backend:test
pnpm backend:build
pnpm frontend:check
pnpm frontend:build
```

The backend suite starts a local Anvil chain; these commands do not broadcast
testnet transactions. Optional historical Perpl fork tests need an archive-capable
Monad Testnet RPC:

```bash
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz pnpm contracts:test
```

## Repository

- `packages/contracts/`: vault, adapter, registry, risk controller and tests.
- `packages/backend/`: service, persistence, qualification, relay and keeper.
- `packages/frontend/`: React app and wallet integration.
- `deployments/`: testnet configuration, verified source and transaction evidence.
- `spikes/perpl-custody/`: earlier standalone custody integration and probes.

The custody prototype is retained as an integration reference; it is separate
from the application vault. AI coding tools were used during implementation and
documentation. The test and receipt records above show what has been verified.
