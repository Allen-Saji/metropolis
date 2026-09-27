import type { Address, Hex } from "viem";
import { API_URL, DEPLOYMENT } from "../config";

export type VaultState = {
  blockNumber: string;
  timestamp: number;
  state: 0 | 1 | 2;
  paused: boolean;
  operator: Address;
  activeAgentId: string;
  idleCollateral: string;
  exchangeBalance: string;
  lockedBalance: string;
  totalShares: string;
  settledAssets: string | null;
  highWaterEquity: string;
  settledUntil: string;
  riskAvailable: boolean;
  risk: { equity: string; btcNotional: string; ethNotional: string } | null;
  positions: Array<{ perpId: string; lotLNS: string; [key: string]: unknown }>;
  accountingMode: "settled-collateral" | "estimated-live-equity";
};

export type ActivityEvent = {
  block_number: string;
  block_hash: Hex;
  tx_hash: Hex;
  log_index: number;
  address: Address;
  name: string;
  data: Record<string, unknown>;
};

export type KeeperStatus = {
  lastOperation: {
    status: string;
    hash: Hex | null;
    error_code: string | null;
    updated_at: string;
  } | null;
  indexedThrough: { block_number: string; block_hash: Hex } | null;
};

export type QualificationObservation = {
  step: number;
  status: "active" | "passed" | "failed" | "invalid";
  scenario: string | null;
  tick: number;
  price: string | null;
  equity: string | null;
  quantity: string;
  maxDrawdownBps: number;
  results: Array<{ name: string; equity: string; trades: number }>;
  reason: string | null;
  suiteHash: Hex;
};

export type QualificationRun = {
  id: string;
  agentId: string;
  operator: Address;
  observation: QualificationObservation;
  deadline: string;
  evidenceHash: Hex | null;
  publication: { status: string; hash: Hex | null; error_code: string | null } | null;
};

export type QualificationSuite = {
  suite: {
    version: string;
    scenarios: Array<{ name: string; prices: number[] }>;
    maxDrawdownBps: number;
    maxOrderBps: number;
  };
  suiteHash: Hex;
  disclosure: string;
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code.replaceAll("_", " ").toLowerCase());
  }
}

async function request<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(new URL(path, API_URL), {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(payload.error ?? `HTTP_${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

const vaultPath = `/v1/vaults/${DEPLOYMENT.vault.toLowerCase()}`;

export const backend = {
  state: (signal?: AbortSignal) => request<VaultState>(`${vaultPath}/state`, { signal }),
  activity: (signal?: AbortSignal) => request<ActivityEvent[]>(`${vaultPath}/activity`, { signal }),
  keeper: (signal?: AbortSignal) => request<KeeperStatus>(`${vaultPath}/keeper`, { signal }),
  suite: (signal?: AbortSignal) => request<QualificationSuite>("/v1/qualification-suite", { signal }),
  challenge: (address: Address) =>
    request<{ nonce: string; message: string; expiresAt: string }>("/v1/auth/nonce", {
      method: "POST",
      body: { address },
    }),
  verify: (nonce: string, signature: Hex) =>
    request<{ token: string; expiresAt: string; address: Address }>("/v1/auth/verify", {
      method: "POST",
      body: { nonce, signature },
    }),
  startRun: (operator: Address, token: string) =>
    request<QualificationRun>(`/v1/agents/${DEPLOYMENT.agentId}/qualification-runs`, {
      method: "POST",
      body: { operator, publish: true },
      token,
    }),
  run: (id: string, token: string) =>
    request<QualificationRun>(`/v1/qualification-runs/${id}/observation`, { token }),
  act: (id: string, step: number, action: { kind: "hold" } | { kind: "target"; targetBps: number }, token: string) =>
    request<QualificationRun>(`/v1/qualification-runs/${id}/actions`, {
      method: "POST",
      body: { step, action },
      token,
    }),
};
