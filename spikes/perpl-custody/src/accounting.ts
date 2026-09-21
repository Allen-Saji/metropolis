// Derived from PerplFoundation/dex-sdk state/account.rs and state/position.rs.
// This is a diagnostic mark-to-market estimate, not an executable redemption quote.
export function positionIds(banks: readonly bigint[]): bigint[] {
  if (banks.length !== 4 || banks.some((bank) => bank < 0n || bank >= 1n << 256n)) {
    throw new Error("Invalid position bitmap");
  }
  const ids: bigint[] = [];
  const offsets = [0, 253, 509, 765];
  banks.forEach((bank, index) => {
    // The first bank's top three bits are not position IDs in the official SDK.
    for (let bit = 0; bit < (index === 0 ? 253 : 256); bit++) {
      if (bank & (1n << BigInt(bit))) ids.push(BigInt(offsets[index]! + bit));
    }
  });
  return ids;
}

export type PositionValue = {
  depositCNS: bigint;
  pnlCNS: bigint;
  deltaPnlCNS: bigint;
  premiumPnlCNS: bigint;
  markPriceValid: boolean;
};

export function estimateEquity(
  idle: bigint,
  balance: bigint,
  locked: bigint,
  positions: readonly PositionValue[],
) {
  if ([idle, balance, locked, ...positions.map((p) => p.depositCNS)].some((n) => n < 0n)) {
    throw new Error("Negative collateral amount");
  }
  if (positions.some((p) => !p.markPriceValid)) throw new Error("Invalid position mark price");
  if (positions.some((p) => p.pnlCNS !== p.deltaPnlCNS + p.premiumPnlCNS)) {
    throw new Error("Position PnL components do not reconcile");
  }
  return {
    // Preserve signed losses; never silently turn an insolvent estimate into zero.
    estimatedEquityCNS: idle + balance + positions.reduce((sum, p) => sum + p.depositCNS + p.pnlCNS, 0n),
    // A balance measure only. Venue freezes, withdrawal limits, and liquidity still apply.
    unlockedExchangeBalanceCNS: balance > locked ? balance - locked : 0n,
  };
}
