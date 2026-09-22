import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage, keccak256, toHex, type Hex } from "viem";
import { migrate, type Database, type Sql } from "../src/db.js";
import type { Gateway, State, Job, Prepared, Event } from "../src/types.js";
export const owner = privateKeyToAccount(generatePrivateKey());
export const operator = privateKeyToAccount(generatePrivateKey());
export const outsider = privateKeyToAccount(generatePrivateKey());
export const lower = <T extends string>(value: T) => value.toLowerCase() as T;
export async function database(): Promise<Database> {
  const p = new PGlite();
  const sql = (client: Pick<PGliteInterface, "query">): Sql => ({
    query: async <T>(query: string, args?: unknown[]) =>
      (await client.query<T>(query, args)).rows,
  });
  const db: Database = {
    ...sql(p),
    exec: async (text) => {
      await p.exec(text);
    },
    close: () => p.close(),
    transaction: (fn) => p.transaction((tx) => fn(sql(tx))),
  };
  await migrate(db);
  return db;
}
export class FakeChain implements Gateway {
  chainId = 10143;
  vault = lower(owner.address);
  registry = lower(outsider.address);
  deploymentBlock = 1n;
  blocks = 1n;
  broadcasts: Hex[] = [];
  prepared = 0;
  throwAfterBroadcast = false;
  consumed = false;
  result: "confirmed" | "reverted" | null = null;
  hash = keccak256(toHex("block"));
  logs: Event[] = [];
  current: State = {
    blockNumber: "1",
    blockHash: this.hash,
    timestamp: Math.floor(Date.now() / 1000),
    state: 0,
    paused: false,
    operator: lower(operator.address),
    activeAgentId: "7",
    nextOrderId: "1",
    accountId: "0",
    exchangeBalance: "0",
    lockedBalance: "0",
    positions: [],
    risk: null,
    riskAvailable: false,
  };
  verify: Gateway["verify"] = (address, message, signature) =>
    verifyMessage({ address, message, signature });
  identityOwner: Gateway["identityOwner"] = async () => lower(owner.address);
  state: Gateway["state"] = async () => this.current;
  validateTrade: Gateway["validateTrade"] = async (raw, wallet) => ({
    raw,
    signer: wallet,
    nonce: 0,
    hash: keccak256(raw),
  });
  prepare: Gateway["prepare"] = async (job: Job): Promise<Prepared> => {
    this.prepared++;
    const raw = toHex(job.id);
    return {
      raw,
      hash: keccak256(raw),
      signer: lower(outsider.address),
      nonce: this.prepared - 1,
    };
  };
  broadcast: Gateway["broadcast"] = async (raw) => {
    this.broadcasts.push(raw);
    if (this.throwAfterBroadcast) throw new Error("timeout");
  };
  receipt: Gateway["receipt"] = async () => this.result;
  nonceConsumed: Gateway["nonceConsumed"] = async () => this.consumed;
  blockHash: Gateway["blockHash"] = async () => this.hash;
  events: Gateway["events"] = async () => this.logs;
}
