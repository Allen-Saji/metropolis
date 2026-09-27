import deployment from "../../../deployments/monad-testnet.json";
import type { Address } from "viem";

export const API_URL =
  import.meta.env.VITE_API_URL ?? "https://backend-production-e090.up.railway.app";
export const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://testnet-rpc.monad.xyz";
export const DEPLOYMENT = {
  chainId: 10143,
  vault: deployment.vault as Address,
  asset: deployment.asset as Address,
  registry: deployment.qualificationRegistry as Address,
  identityRegistry: deployment.identityRegistry as Address,
  agentId: BigInt(deployment.agentId),
  operator: deployment.operator as Address,
  suiteHash: deployment.suiteHash as `0x${string}`,
};

const CALLSIGNS = [
  "VOID JACKAL",
  "NEON SPECTRE",
  "OMEGA GREMLIN",
  "RIFT VULTURE",
  "PHANTOM ALPHA",
  "HYPER GOBLIN",
] as const;

export function agentCallsign(agentId: string | bigint): string {
  if (BigInt(agentId) === DEPLOYMENT.agentId) return "VOID JACKAL";
  return CALLSIGNS[Number(BigInt(agentId) % BigInt(CALLSIGNS.length))]!;
}
