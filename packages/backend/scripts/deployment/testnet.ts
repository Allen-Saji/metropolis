import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encodeDeployData,
  encodeFunctionData,
  parseAbi,
  parseEventLogs,
  parseEther,
  keccak256,
  type Hex,
  type Address,
  type Abi,
} from "viem";
import { SUITE_HASH } from "../../src/qualification.js";
import { ensure, json } from "../../src/common.js";
import { publicClient, sendStep } from "./journal.js";

// Official ERC-8004 deployment list distinguishes testnet from mainnet.
// https://github.com/erc-8004/erc-8004-contracts#monad-testnet
export const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc" as const;
export const ASSET = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc" as const;
const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
const directory =
  process.env.METROPOLIS_PRIVATE_DIR ?? join(homedir(), ".config/metropolis");
async function secretFile(path: string) {
  ensure(((await stat(path)).mode & 0o077) === 0, "INSECURE_SECRET_FILE");
  return parseEnv(await readFile(path, "utf8"));
}
async function artifact(
  name: string,
): Promise<{ abi: Abi; bytecode: { object: Hex } }> {
  return JSON.parse(
    await readFile(
      new URL(
        `../../../contracts/out/${name}.sol/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}
async function main() {
  ensure(
    process.env.METROPOLIS_TESTNET_DEPLOY === "true",
    "Set METROPOLIS_TESTNET_DEPLOY=true to broadcast testnet transactions",
  );
  ensure((await publicClient.getChainId()) === 10143, "TESTNET_ONLY");
  const context = await (
    await fetch("https://testnet.perpl.xyz/api/v1/pub/context")
  ).json();
  ensure(
    context.instances.some(
      (i: { address: string }) => i.address.toLowerCase() === EXCHANGE,
    ),
    "EXCHANGE_CONTEXT_MISMATCH",
  );
  ensure(
    context.tokens.some(
      (t: { address: string }) => t.address.toLowerCase() === ASSET,
    ),
    "ASSET_CONTEXT_MISMATCH",
  );
  for (const address of [IDENTITY, EXCHANGE, ASSET])
    ensure(await publicClient.getBytecode({ address }), "MISSING_CONTRACT");
  const spike = await secretFile(join(directory, "perpl-spike.env"));
  ensure(
    spike.MONAD_TESTNET_PRIVATE_KEY && spike.MONAD_TESTNET_OPERATOR_PRIVATE_KEY,
    "MISSING_TESTNET_SIGNERS",
  );
  const owner = privateKeyToAccount(spike.MONAD_TESTNET_PRIVATE_KEY as Hex),
    operator = privateKeyToAccount(
      spike.MONAD_TESTNET_OPERATOR_PRIVATE_KEY as Hex,
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rolesFile = join(directory, "backend-testnet.env");
  try {
    await stat(rolesFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(
      rolesFile,
      `EVALUATOR_PRIVATE_KEY=${generatePrivateKey()}\nKEEPER_PRIVATE_KEY=${generatePrivateKey()}\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  const roles = await secretFile(rolesFile);
  const evaluator = privateKeyToAccount(roles.EVALUATOR_PRIVATE_KEY as Hex),
    keeper = privateKeyToAccount(roles.KEEPER_PRIVATE_KEY as Hex);
  ensure(
    new Set([
      owner.address,
      operator.address,
      evaluator.address,
      keeper.address,
    ]).size === 4,
    "SIGNER_ROLES_MUST_DIFFER",
  );
  const journal = join(directory, "testnet-deployment-v1");
  const metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Metropolis Reference Agent",
    description:
      "Monad Testnet reference agent for public deterministic risk-policy qualification. No mainnet capital or profitability guarantee.",
    active: false,
    services: [],
    supportedTrust: [],
  };
  const uri = `data:application/json;base64,${Buffer.from(json(metadata)).toString("base64")}`;
  const registration = await sendStep(journal, "register-agent", owner, {
    to: IDENTITY,
    data: encodeFunctionData({
      abi: identityAbi,
      functionName: "register",
      args: [uri],
    }),
  });
  const [registered] = parseEventLogs({
    abi: identityAbi,
    eventName: "Registered",
    logs: registration.logs.filter(
      (l) => l.address.toLowerCase() === IDENTITY.toLowerCase(),
    ),
  });
  ensure(registered, "REGISTRATION_EVENT_MISSING");
  const agentId = registered.args.agentId;
  ensure(
    (
      await publicClient.readContract({
        address: IDENTITY,
        abi: identityAbi,
        functionName: "ownerOf",
        args: [agentId],
      })
    ).toLowerCase() === owner.address.toLowerCase(),
    "IDENTITY_OWNER_MISMATCH",
  );
  const registryArtifact = await artifact("QualificationRegistry");
  const reg = await sendStep(journal, "deploy-registry", owner, {
    data: encodeDeployData({
      abi: registryArtifact.abi,
      bytecode: registryArtifact.bytecode.object,
      args: [IDENTITY, evaluator.address],
    }),
  });
  ensure(reg.contractAddress, "REGISTRY_DEPLOYMENT_FAILED");
  const vaultArtifact = await artifact("MetropolisVault");
  const deployed = await sendStep(journal, "deploy-vault", owner, {
    data: encodeDeployData({
      abi: vaultArtifact.abi,
      bytecode: vaultArtifact.bytecode.object,
      args: [ASSET, EXCHANGE, reg.contractAddress, SUITE_HASH, owner.address],
    }),
  });
  ensure(deployed.contractAddress, "VAULT_DEPLOYMENT_FAILED");
  const vault = deployed.contractAddress;
  const read = <T>(functionName: string) =>
    publicClient.readContract({
      address: vault,
      abi: vaultArtifact.abi,
      functionName,
    }) as Promise<T>;
  const [adapter, risk, suite, manager] = await Promise.all([
    read<Address>("adapter"),
    read<Address>("risk"),
    read<Hex>("requiredSuite"),
    read<Address>("owner"),
  ]);
  ensure(
    suite === SUITE_HASH &&
      manager.toLowerCase() === owner.address.toLowerCase(),
    "VAULT_CONFIG_MISMATCH",
  );
  for (const [label, account] of [
    ["evaluator", evaluator],
    ["keeper", keeper],
  ] as const) {
    await sendStep(journal, `fund-${label}`, owner, {
      to: account.address,
      value: parseEther("0.25"),
    });
  }
  const codes = await Promise.all(
    [reg.contractAddress, vault, adapter, risk].map(async (address) => ({
      address,
      codeHash: keccak256((await publicClient.getBytecode({ address }))!),
    })),
  );
  const manifest = {
    chainId: 10143,
    identityRegistry: IDENTITY,
    agentId: agentId.toString(),
    agentURI: uri,
    exchange: EXCHANGE,
    asset: ASSET,
    qualificationRegistry: reg.contractAddress,
    vault,
    adapter,
    risk,
    suiteHash: SUITE_HASH,
    owner: owner.address,
    operator: operator.address,
    evaluator: evaluator.address,
    keeper: keeper.address,
    deploymentBlock: deployed.blockNumber.toString(),
    registrationTx: registration.transactionHash,
    registryTx: reg.transactionHash,
    vaultTx: deployed.transactionHash,
    codeHashes: codes,
  };
  const manifestPath = new URL(
    "../../../../deployments/monad-testnet.json",
    import.meta.url,
  );
  await writeFile(manifestPath, json(manifest) + "\n");
  console.log(json(manifest));
}
main().catch((error) => {
  console.error(
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "Testnet deployment did not complete; inspect the private transaction journal and retry with identical inputs.",
  );
  process.exitCode = 1;
});
