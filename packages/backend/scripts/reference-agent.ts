import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import type { Hex } from "viem";
import { ensure } from "../src/common.js";

async function main() {
  const base = process.env.BACKEND_URL ?? "http://127.0.0.1:3001";
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  const ownerKey = process.env.AGENT_OWNER_PRIVATE_KEY,
    operatorKey = process.env.AGENT_OPERATOR_PRIVATE_KEY,
    agentId = process.env.AGENT_ID;
  ensure(
    ownerKey && operatorKey && agentId,
    "Set AGENT_OWNER_PRIVATE_KEY, AGENT_OPERATOR_PRIVATE_KEY and AGENT_ID",
  );
  const owner = privateKeyToAccount(ownerKey as Hex),
    operator = privateKeyToAccount(operatorKey as Hex);
  async function post(path: string, payload: unknown, bearer?: string) {
    const response = await fetch(new URL(path, base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    ensure(response.ok, `HTTP_${response.status}`);
    return response.json();
  }
  async function login(account: typeof owner) {
    const challenge = await post("/v1/auth/nonce", {
      address: account.address,
    });
    const parsed = parseSiweMessage(challenge.message);
    ensure(
      parsed.chainId === 10143 &&
        parsed.domain === new URL(origin).host &&
        parsed.uri === origin &&
        parsed.address?.toLowerCase() === account.address.toLowerCase() &&
        parsed.nonce === challenge.nonce,
      "Unexpected sign-in challenge",
    );
    return (
      await post("/v1/auth/verify", {
        nonce: challenge.nonce,
        signature: await account.signMessage({ message: challenge.message }),
      })
    ).token as string;
  }
  const ownerToken = await login(owner),
    operatorToken = await login(operator);
  let run = await post(
    `/v1/agents/${agentId}/qualification-runs`,
    { operator: operator.address, publish: true },
    ownerToken,
  );
  while (run.observation.status === "active") {
    run = await post(
      `/v1/qualification-runs/${run.id}/actions`,
      {
        step: run.observation.step,
        action:
          run.observation.tick === 0
            ? { kind: "target", targetBps: 1000 }
            : { kind: "hold" },
      },
      operatorToken,
    );
  }
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.observation.status,
        evidenceHash: run.evidenceHash,
        publication: run.publication,
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "Reference qualification failed; check backend availability, identity ownership and signer configuration.",
  );
  process.exitCode = 1;
});
