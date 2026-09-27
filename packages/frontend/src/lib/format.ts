import { formatUnits, type Address } from "viem";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatAmount(raw: string | bigint | null | undefined, decimals = 6): string {
  if (raw === null || raw === undefined) return "--";
  try {
    return number.format(Number(formatUnits(BigInt(raw), decimals)));
  } catch {
    return "--";
  }
}

export function formatCompact(raw: string | bigint | null | undefined, decimals = 6): string {
  if (raw === null || raw === undefined) return "--";
  try {
    return compactNumber.format(Number(formatUnits(BigInt(raw), decimals)));
  } catch {
    return "--";
  }
}

export function shortAddress(address: Address | string | null | undefined): string {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "--";
}

export function lifecycleLabel(state: number | undefined): string {
  return state === 0 ? "Settled" : state === 1 ? "Trading" : state === 2 ? "Settling" : "Syncing";
}

export function formatDate(seconds: bigint | string | number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "--";
  const value = Number(seconds);
  if (!Number.isFinite(value) || value === 0) return "--";
  return new Date(value * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: number | string }).code;
    if (code === 4001 || code === "ACTION_REJECTED") return "The wallet request was cancelled.";
    const short = (error as { shortMessage?: string }).shortMessage;
    if (short) return short;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
