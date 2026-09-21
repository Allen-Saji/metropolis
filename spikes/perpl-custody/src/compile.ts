import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sourcePath = resolve(root, "contracts/PerplCustodyHarness.sol");
const outputPath = resolve(root, "artifacts/PerplCustodyHarness.json");
const source = await readFile(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: { "PerplCustodyHarness.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, unknown>>;
};

const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
if (errors.length > 0) {
  throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
}

const contract = output.contracts?.["PerplCustodyHarness.sol"]?.["PerplCustodyHarness"] as
  | { abi: unknown; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }
  | undefined;
if (!contract?.evm.bytecode.object) throw new Error("Harness compilation produced no bytecode");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({
    contractName: "PerplCustodyHarness",
    compilerVersion: solc.version(),
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  }, null, 2)}\n`,
);

console.log(JSON.stringify({
  compilerVersion: solc.version(),
  outputPath,
  bytecodeBytes: contract.evm.bytecode.object.length / 2,
  deployedBytecodeBytes: contract.evm.deployedBytecode.object.length / 2,
}, null, 2));
