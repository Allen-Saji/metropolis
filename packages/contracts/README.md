# Metropolis contracts

A single AUSD vault with evaluator-gated agent trading and settled-window share
conversions. These are the application contracts, separate from the custody spike.
They are under development for testnet and have not been audited or deployed.

## Build and test

Install pnpm 10.8.1 and Foundry, then run from the repository root:

```bash
pnpm install --frozen-lockfile
export PATH="$HOME/.foundry/bin:$PATH"
pnpm contracts:build
pnpm contracts:test
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz pnpm contracts:test
```

The final command also runs two optional tests on a local fork at block 64497756.
It never signs or broadcasts transactions. Without the RPC variable, the fork
suite is skipped. RPC historical-state availability is required. The fork uses a
test identity registry and evaluator attestation; it does not prove the real
ERC-8004 enrollment or evaluation service. OpenZeppelin is pinned to 5.4.0;
Foundry compiles Solidity 0.8.28 for Cancun.

## Contracts

| Contract | Responsibility |
| --- | --- |
| `MetropolisVault` | Shares, deposits, redemption, agent selection, lifecycle and trading gate |
| `PerplAdapter` | Owns a Perpl account; only its immutable vault can call it |
| `RiskController` | Fixed exposure, drawdown, price-age and order bounds |
| `QualificationRegistry` | Evaluator-controlled, expiring qualification bound to identity owner, execution key and suite |

The vault constructs its adapter and risk controller. No adapter transfer of
ownership is needed. The manager and evaluator are separate configurable roles;
both use two-step ownership transfer. Manager privileges do not include taking
user collateral or bypassing trading limits. The evaluator remains trusted to
issue truthful qualification results and bind the authorized execution key.

## Lifecycle

1. **Settled:** accept deposits and redeem shares against actual token balances.
2. **Trading:** manager funds Perpl and the qualified operator submits constrained
   immediate-or-cancel orders. Deposit and redemption calls revert.
3. **Settling:** stop opening exposure, close positions, recover collateral, then
   return to Settled. Only recovered funds can support share conversions.

The manager or any shareholder can request settlement. Anyone can execute the
fixed-price-bound close helper, recover collateral to the vault, and finalize
settlement. Recovery supports multiple withdrawals if the venue throttles them.
Finalization requires no positions, no order locks, no locked collateral and zero
remaining Perpl balance. The manager must leave a one-hour exit window after
deployment and each settlement before starting another trading epoch.

An administrator pause stops deposits and starts settlement when trading. It
never blocks settled redemptions. Qualification expiry, revocation, or identity
ownership changes block new exposure but do not block position closure.

## Share accounting

Shares use 12 decimals; collateral must have 6 decimals. Conversions use one
virtual asset unit and 1,000,000 virtual share units, with floor rounding, based on
the [OpenZeppelin virtual-offset design](https://docs.openzeppelin.com/contracts/5.x/erc4626).
Virtual units mitigate first-depositor donation manipulation. Callers must supply
minimum shares/assets based on a recent quote; zero-share deposits always revert.
Direct donations to the vault or adapter are included in settled backing.

Virtual units can retain residual collateral after the last redemption; the
manager cannot sweep it. This is deliberate and is not promised as recoverable
user dust. A total loss blocks recapitalization until all outstanding shares are
burned through zero-value redemptions. There are no management/performance fees.

This is **not ERC-4626**. `settledAssets`, `previewDeposit`, and `previewRedeem`
revert outside Settled. Live equity is a risk estimate, not a redemption promise.

## Fixed V1 risk policy

- BTC (Perpl 16) and ETH (Perpl 32); at most those two positions.
- 2x maximum order leverage; per-market notional at most current equity;
  aggregate notional at most 2x current equity.
- Each new order is at most 25% of current equity, conservatively valued at the
  higher of mark and limit price. Existing exposure is counted before execution,
  and exposure is checked again after fills.
- Opening is blocked beyond 10% drawdown from the epoch's observed equity high.
- Marks must be nonzero, not future-dated and no older than 60 seconds. Position
  marks must be valid and PnL components must reconcile.
- Limit price within 1% of mark, maximum 20 matches, transaction deadline within
  20 blocks, sequential request IDs, and no optional builder fee extensions.
- IOC only: no resting orders, forwarded execution, arbitrary calls, collateral
  adjustments, or operator withdrawals. A post-trade order lock reverts execution.

`checkpointRisk` can be called by anyone to move into Settling on a breach or
unreadable risk state. A chain contract does not wake itself: a keeper must call
this periodically. New orders independently enforce the risk checks even if the
keeper is offline. The high-water mark is observed at trades/checkpoints, not
every historical price tick. It resets at the start of each trading epoch.

## Frontend and service boundary

- User: `deposit(assets, receiver, minShares)`, `redeem(shares, receiver, minAssets)`,
  `requestSettlement()`.
- Manager: `activateAgent(agentId, operator)`, `startTrading(assets)`, `setPaused(bool)`.
- Operator: `executeTrade(OrderDesc)`; read `nextOrderId` immediately before sending.
- Keeper/recovery: `checkpointRisk()`, `closePosition(perpId)`,
  `recoverCollateral(assets)`, `finishSettlement()`.
- Quotes: `state`, `paused`, `settledUntil`, `balanceOf`, `totalSupply`,
  `settledAssets`, `previewDeposit`, `previewRedeem` and `risk.snapshot(vault, adapter)`.
- Activity: `Deposited`, `Redeemed`, `AgentActivated`, `StateChanged`,
  `TradeExecuted`, `CollateralRecovered`, `PauseChanged` and Perpl fill events.

During Trading/Settling, display conversions as unavailable. A successful IOC
transaction may have no fill or a partial fill; reconcile actual venue events and
positions. `TradeExecuted` means the request completed, not that it filled fully.
Never automatically resubmit an ambiguous transaction with a new request ID.

## Verification and remaining limits

Unit and fuzz tests exercise multiple depositors, realized losses, donations,
minimum outputs, qualification changes, permissions, risk checks, partial recovery,
stale data, venue failure and epoch reuse. The fork tests read the historical
spike position and execute the new vault's deposit/trade/settlement/redemption
cycle against actual Perpl and AUSD bytecode.

Public-testnet deployment and operation remain unverified for these contracts.
The API, qualification runner, keeper, frontend, deployment tooling, and real
ERC-8004 enrollment are still to be built. Venue contracts, token administrators,
oracle data and liquidity remain external trust/availability dependencies.
Settlement has no guaranteed deadline: stale marks, venue failure or insufficient
liquidity can prevent closure/recovery. The venue may upgrade independently of our
immutable adapter. Mainnet and real user capital are out of scope.

Perpl interface source:
[official SDK ABI at 5b5be46](https://github.com/PerplFoundation/dex-sdk/blob/5b5be46a3349d719fbb59a08cf3955194bc8dfd8/crates/sdk/abi/dex/Exchange.json).
