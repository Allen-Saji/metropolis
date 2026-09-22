# Monad Testnet deployment

`monad-testnet.json` identifies the deployed application, dedicated testnet roles,
ERC-8004 reference agent and runtime code hashes. `monad-testnet-settled-proof.json`
records the successful qualification/activation and 100 AUSD deposit/redemption
cycle. `monad-testnet-backend-proof.json` records actual PostgreSQL-backed
publication and indexed events.

The vault, adapter, risk controller and qualification registry have exact runtime
matches on Sourcify. Verification job responses are retained in
`monad-testnet-source-verification.json`. Automatic mirroring to Etherscan hit
provider limits; do not interpret Sourcify verification as Etherscan verification.

The reference agent is registered on the official testnet IdentityRegistry at
`0x8004A818BFB912233c491871b3d84c89A494BD9e`. Mainnet uses a different address.
Source: [official ERC-8004 deployment list](https://github.com/erc-8004/erc-8004-contracts#monad-testnet).
Its agent card is self-contained on-chain metadata and is marked inactive until
public service endpoints are available.

## Repeatable deployment tooling

The scripts are testnet-only and require explicit broadcast enablement. They load
secrets from a private directory (default `$HOME/.config/metropolis`, override
`METROPOLIS_PRIVATE_DIR`). They reject secret files readable by other users.

- `perpl-spike.env`: dedicated `MONAD_TESTNET_PRIVATE_KEY` and
  `MONAD_TESTNET_OPERATOR_PRIVATE_KEY` used by the custody integration.
- `backend-testnet.env`: evaluator and keeper keys; generated once if absent.
- `testnet-deployment-v1/`: per-step signed transaction journals.
- `testnet-settled-cycle-v1/`: activation/deposit/redemption transaction journals.

These files never belong in the repository. Run one deployment workflow per owner
at a time. Each step persists signed bytes before broadcast and reconciles the
same hash on retry. Changed arguments or consumed unknown nonces stop execution;
it never silently deploys another vault or registers another agent.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
pnpm contracts:build
METROPOLIS_TESTNET_DEPLOY=true pnpm --filter @metropolis/backend testnet:deploy
```

Deployment validates the chain ID, live Perpl context, contract code, role
separation and suite hash. It registers the reference agent, deploys the registry
and vault, and funds each new evaluator/keeper with 0.25 testnet MON. Transactions
have gas and fee caps. Re-running with the same journal does not repeat transfers.

Run the backend and reference qualification client as described in
[backend operations](../packages/backend/README.md). After the evaluator publishes
its passing result, prove the settled vault path:

```bash
METROPOLIS_TESTNET_DEPLOY=true pnpm --filter @metropolis/backend testnet:settled-cycle
```

This activates the qualified agent, approves/deposits 100 test AUSD, then redeems
all resulting shares and reconciles the owner's balance. It does not place a
Perpl order or bypass the vault's one-hour initial redemption window.

## Remaining verification

A real Perpl trade through this application vault and automatic keeper-driven
close/recovery are still pending. Existing Perpl trades belong to the earlier
custody spike, and the application trading flow has passed only local/fork tests.
The API/PostgreSQL path was verified locally against public testnet; public API
hosting and frontend integration are not yet live. No user collateral remains
in the application vault after the settled proof.
