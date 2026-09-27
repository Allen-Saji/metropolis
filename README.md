# Metropolis

Metropolis is a trust-gated agentic trading vault for Monad. An agent must pass a
qualification before it can trade vault collateral. Users receive shares, observe
risk, and redeem after positions close and collateral returns to the vault.

## Implementation status

The application contract package implements a single testnet AUSD vault,
qualification registry, vault-owned Perpl adapter, and on-chain risk controller.
It supports deposit, trading, settlement, and redemption with multiple depositors.
The new contracts are locally tested, including execution against Perpl bytecode
on a historical Monad Testnet fork. They are now deployed on public Monad Testnet
with exact runtime source matches on Sourcify; see [deployment records](deployments/README.md).

The earlier custody spike remains a separate integration reference. The backend
API, qualification runner, signed-transaction relay and keeper use PostgreSQL
persistence and have a local EVM integration test. Real ERC-8004 enrollment,
qualification publication, and a 100 AUSD settled deposit/redemption are verified.
A later [live application-vault cycle](deployments/monad-testnet-live-cycle-proof.json)
deposited 1,000 AUSD, relayed a 0.001 BTC Perpl trade, rejected an oversized order
in simulation, closed through the keeper, and redeemed 999.888103 AUSD. All shares,
venue collateral, and positions were zero afterward. The testnet API is hosted at
https://backend-production-e090.up.railway.app on Railway Hobby with Supabase
PostgreSQL. The local frontend reads the hosted API and public Monad Testnet
contracts. It includes a live console, wallet deposit/redemption and manager
controls, qualification flow, event stream and risk-policy display. See the
[frontend guide](packages/frontend/README.md).
This project is not ready for mainnet or real user capital.

## Repository

- `packages/contracts/`: application Solidity contracts, unit/fuzz tests, and
  optional Perpl fork tests. See [contract documentation](packages/contracts/README.md)
  for permissions, risk policy, accounting, and frontend integration.
- `packages/backend/`: Fastify API, qualification runner, transaction journal,
  finalized indexer and keeper. See [backend documentation](packages/backend/README.md).
- `packages/frontend/`: React terminal for live vault reads and wallet actions.
  See [frontend documentation](packages/frontend/README.md).
- `spikes/perpl-custody/`: original custody proof and read-only accounting probes.

## Development

Requires pnpm 10.8.1 and Foundry (tested with 1.5.1). Solidity 0.8.28 is configured
in the contract package; OpenZeppelin dependencies are pinned in the lockfile.

```bash
pnpm install --frozen-lockfile
export PATH="$HOME/.foundry/bin:$PATH"
pnpm contracts:build
pnpm contracts:test
pnpm spike:test
pnpm backend:check
pnpm backend:test
pnpm backend:build
pnpm frontend:check
pnpm frontend:build
```

Run the local frontend with `pnpm frontend:dev` and open
`http://localhost:3000`. The hosted API currently allows that exact origin.

To run the optional historical fork integration tests:

```bash
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz pnpm contracts:test
```

Fork tests use local simulated transactions against fetched chain state. They do
not require a wallet or broadcast transactions. The fork suite skips explicitly
when no RPC URL is configured.

## Custody spike tools

```bash
pnpm spike:probe
pnpm spike:compile
pnpm spike:check
PERPL_HARNESS_ADDRESS=0xf628b42d22c3a2adda10008c09db4e708c527549 pnpm spike:accounting
```

`pnpm spike:live` is deliberately guarded. It requires separate dedicated owner
and operator Monad Testnet keys, testnet MON for both, and enough AUSD collateral.
It never prints either key. The completed cycle can be independently checked with
`pnpm spike:verify-live`. See the [spike documentation](spikes/perpl-custody/README.md).
