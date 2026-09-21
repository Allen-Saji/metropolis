# Perpl custody spike

This spike tests whether a Metropolis vault can own a Perpl Testnet account,
execute bounded trades, reconcile fills, close positions, and recover collateral
without giving the agent withdrawal authority.

## Proven without credentials

- Perpl Testnet public context is live.
- Chain ID is `10143`.
- The live exchange is discovered from context rather than hardcoded.
- The live collateral token is discovered from context rather than hardcoded.
- The context and contracts agree on the minimum account-opening collateral.
- BTC and ETH markets are live.
- The official Exchange ABI exposes account creation, deposit, direct order
  execution, position reads, forwarding control, and collateral withdrawal.
- Direct Exchange calls use `msg.sender` as the account owner, so a contract can be
  the custody boundary.
- Perpl API keys use Ed25519 request signatures and trade-scoped keys cannot
  withdraw or transfer collateral.
- Agora's live Monad Testnet faucet contract dispenses 10,000 AUSD per request,
  which is enough to cover Perpl's current 100 AUSD account-opening minimum.

## Custody architecture decision

Perpl publishes a DelegatedAccount factory on testnet. It separates an owner
from an operator, but every account created by that factory is a beacon proxy.
The live beacon owner is an externally owned account that can replace the
implementation used by every delegated account.

That is acceptable as a clearly disclosed integration option, but it is not the
strongest proof that Metropolis controls custody. The primary spike therefore
uses an immutable Metropolis adapter. Perpl's factory remains a reference and a
possible fast integration path, not the vault's custody root.

## Live result

The immutable adapter completed a real testnet custody cycle on 2026-09-21.
The final deployed adapter is `0xf628b42d22c3a2adda10008c09db4e708c527549`
and owns Perpl account `648`. The operator opened and closed a 0.001 BTC long.
The owner recovered 99.915966 AUSD from the 100 AUSD deposit. This difference
is trading PnL and fees, not unrecovered collateral. The independent verifier
confirmed the Perpl exchange balance, locked balance, BTC position, and adapter
idle balance are all zero.

The operator's direct withdrawal and idle-collateral recovery calls reverted
with `Unauthorized`. A nonempty V2 order extension reverted with
`InvalidExtension`, preventing the hot operator from attaching an additive
builder fee. Perpl emitted open and close request/fill events, a position-open
event, a position-close event, and the final collateral-withdrawal event.

This proves custody separation and the live execution path. It does not prove
ERC-4626 share accounting, safe concurrent user redemptions, aggregate risk
limits, pause semantics, or API-key enrollment. Those belong to the vault build.

## Important live observation

The live Testnet context currently reports AUSD collateral at
`0xa9012a055bd4e0edff8ce09f960291c09d5322dc` with a minimum account opening amount
of 100 AUSD. An older table in the API README lists a different testnet collateral
address. Always trust and validate the live `/v1/pub/context` response.

## Harness model

`PerplCustodyHarness` owns the Perpl exchange account because the harness itself
calls the Exchange. The owner controls account creation, deposits, forwarding, and
withdrawal. A separate operator may call only the bounded order function. The live
script refuses to proceed if the owner and operator addresses are the same.

The order function permits only BTC and ETH, caps leverage at 2x, caps raw lot and
collateral amounts, and does not expose arbitrary calls. This is a spike harness,
not the final ERC-4626 vault.

## Commands

Read account equity inputs at a single finalized block without credentials:

```bash
PERPL_HARNESS_ADDRESS=0xf628b42d22c3a2adda10008c09db4e708c527549 pnpm spike:accounting
pnpm spike:test
```

Set `PERPL_SNAPSHOT_TX_HASH` to read the end of a historical transaction's block
(requires historical state support from the RPC). This is not transaction-level
state: later transactions in that block are included. All account, token, position,
and order-lock reads use the same block number. Invalid marks and inconsistent
PnL components cause an error. All amounts are integer strings in collateral
native units, with token decimals included in the output.

The estimate includes idle collateral, exchange balance, position margin, and
signed unrealized PnL. Order-locked collateral is already part of exchange balance;
it must not be added a second time. The estimate is not a redemption quote or
proof of ERC-4626 compliance. Historical fixtures cover the completed BTC trade;
liquidations, multiple positions, and withdrawal limits remain unverified.

Accounting references: [Perpl account state](https://github.com/PerplFoundation/dex-sdk/blob/5b5be46a3349d719fbb59a08cf3955194bc8dfd8/crates/sdk/src/state/account.rs),
[Perpl position state](https://github.com/PerplFoundation/dex-sdk/blob/5b5be46a3349d719fbb59a08cf3955194bc8dfd8/crates/sdk/src/state/position.rs).

```bash
pnpm install
pnpm spike:probe
pnpm spike:compile
pnpm spike:check
```

The live step requires:

```bash
export MONAD_TESTNET_PRIVATE_KEY=0x...
export MONAD_TESTNET_OPERATOR_PRIVATE_KEY=0x...
pnpm spike:prepare-funds
pnpm spike:live
```

Verify a completed cycle from chain state and receipts:

```bash
PERPL_HARNESS_ADDRESS=0x... \
PERPL_OPEN_TX_HASH=0x... \
PERPL_CLOSE_TX_HASH=0x... \
PERPL_WITHDRAW_TX_HASH=0x... \
pnpm spike:verify-live
```

`spike:prepare-funds` uses Agora's on-chain AUSD faucet after the owner has native
MON, then transfers a bounded share of the owner's testnet MON to the operator for
gas. `spike:live` checks key separation, both MON balances, and the AUSD balance
before deploying. Neither command prints a private key.

## Completed live gates

1. Fund the dedicated owner with native Monad Testnet MON.
2. Request AUSD from Agora's on-chain testnet faucet and fund the separate
   operator with gas.
3. Deploy the harness from the owner and prove an operator withdrawal simulation
   reverts.
4. Transfer the current 100 AUSD minimum into the harness.
5. Create the contract-owned Perpl account.
6. Construct and simulate a bounded BTC order from live price and scaling data.
7. Submit the order from the operator and reconcile the position.
8. Close the position from the operator.
9. Withdraw collateral to the harness and recover it to the owner.

All nine gates passed for the adapter and dedicated testnet accounts above.
