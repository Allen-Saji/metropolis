import type { Address, Hex } from "viem";
import type { Evaluation, Action } from "./qualification.js";
export type Run = {
  id: string;
  agent_id: string;
  owner: Address;
  operator: Address;
  suite_hash: Hex;
  state: Evaluation;
  actions: { step: number; action: Action; hash: Hex }[];
  status: Evaluation["status"];
  deadline: Date;
  created_at: Date;
  evidence: unknown;
  evidence_hash: Hex | null;
};
type JobBase = {
  id: string;
  status: string;
  signer: Address | null;
  nonce: string | null;
  raw: Hex | null;
  hash: Hex | null;
  error_code: string | null;
  created_at: Date;
};
export type Job = JobBase &
  (
    | { kind: "trade"; payload: { wallet: Address } }
    | { kind: "keeper"; payload: { method: string; argument?: string } }
    | {
        kind: "qualification";
        payload: {
          runId: string;
          agentId: string;
          owner: Address;
          operator: Address;
          suite: Hex;
          evidence: Hex;
          passed: boolean;
          expiresAt: number;
        };
      }
  );
export type Prepared = { signer: Address; nonce: number; raw: Hex; hash: Hex };
export type State = {
  blockNumber: string;
  blockHash: Hex;
  timestamp: number;
  state: number;
  paused: boolean;
  operator: Address;
  activeAgentId: string;
  nextOrderId: string;
  accountId: string;
  exchangeBalance: string;
  lockedBalance: string;
  positions: { perpId: string; lotLNS: string; [key: string]: unknown }[];
  risk: unknown;
  riskAvailable: boolean;
  [key: string]: unknown;
};
export type Event = {
  blockNumber: string;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  address: Address;
  name: string;
  data: unknown;
};
export interface Gateway {
  chainId: number;
  vault: Address;
  registry: Address;
  deploymentBlock: bigint;
  verify(address: Address, message: string, signature: Hex): Promise<boolean>;
  identityOwner(agentId: string): Promise<Address>;
  state(): Promise<State>;
  validateTrade(raw: Hex, wallet: Address): Promise<Prepared>;
  prepare(job: Job): Promise<Prepared>;
  broadcast(raw: Hex): Promise<void>;
  receipt(hash: Hex): Promise<"confirmed" | "reverted" | null>;
  nonceConsumed(signer: Address, nonce: number): Promise<boolean>;
  blockHash(block: bigint): Promise<Hex>;
  events(from: bigint, to: bigint): Promise<Event[]>;
}
