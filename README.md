# Metropolis

Metropolis is a trust-gated agentic trading vault for Monad. An agent must pass a
qualification before it can trade vault collateral. Users receive shares, observe
risk, and redeem after positions close and collateral returns to the vault.

## Implementation status

The application contract package implements a single testnet AUSD vault,
qualification registry, vault-owned Perpl adapter, and on-chain risk controller.
It supports deposit, trading, settlement, and redemption with multiple depositors.
The new contracts are locally tested, including execution against Perpl bytecode
on a historical Monad Testnet fork. They have not been deployed to public testnet.

The earlier custody spike separately completed real public-testnet trades. It
remains an integration reference, not the application vault. Backend API,
qualification runner, keeper, frontend, and deployment tooling are still pending.
This project is not ready for mainnet or real user capital.

## Repository

- `packages/contracts/`: application Solidity contracts, unit/fuzz tests, and
  optional Perpl fork tests. See [contract documentation](packages/contracts/README.md)
  for permissions, risk policy, accounting, and frontend integration.
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
```

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
