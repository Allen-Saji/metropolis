import {
  createPublicClient,
  formatUnits,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { defineChain } from "viem/utils";
import { erc20Abi, exchangeEventAbi, exchangeReadAbi, harnessAbi } from "./abis.js";
import { DEFAULTS, fetchPerplContext, primaryInstance } from "./config.js";

const chain = defineChain({
  id: DEFAULTS.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl] } },
});

async function main() {
  const value = process.env.PERPL_HARNESS_ADDRESS;
  if (!value || !isAddress(value)) {
    throw new Error("PERPL_HARNESS_ADDRESS must be a deployed testnet address");
  }
  const harness = value as Address;
  const context = await fetchPerplContext();
  const { instance, collateral } = primaryInstance(context);
  const exchange = instance.address as Address;
  const collateralAddress = collateral.address as Address;
  const client = createPublicClient({
    chain,
    transport: http(process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl),
  });

  const [code, owner, operator, harnessExchange, harnessCollateral, account, idle] = await Promise.all([
    client.getBytecode({ address: harness }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "owner" }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "operator" }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "exchange" }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "collateral" }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "account" }),
    client.readContract({ address: harness, abi: harnessAbi, functionName: "idleCollateral" }),
  ]);

  if (!code) throw new Error("Harness bytecode missing");
  if (harnessExchange.toLowerCase() !== exchange.toLowerCase()) throw new Error("Wrong Perpl exchange");
  if (harnessCollateral.toLowerCase() !== collateralAddress.toLowerCase()) throw new Error("Wrong collateral token");
  if (account[0] === 0n || account[4].toLowerCase() !== harness.toLowerCase()) {
    throw new Error("Perpl account is not owned by the harness");
  }

  const btc = context.markets.find((market) => market.symbol === "BTC");
  if (!btc) throw new Error("BTC market is unavailable");
  const [position, ownerAusd, harnessAusd] = await Promise.all([
    client.readContract({
      address: exchange,
      abi: exchangeReadAbi,
      functionName: "getPositionV2",
      args: [BigInt(btc.perpetual_id), account[0]],
    }),
    client.readContract({
      address: collateralAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
    client.readContract({
      address: collateralAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [harness],
    }),
  ]);

  const recovered = account[1] === 0n && account[2] === 0n && position[0].lotLNS === 0n
    && idle === 0n && harnessAusd === 0n;
  const hashes = [
    process.env.PERPL_OPEN_TX_HASH,
    process.env.PERPL_CLOSE_TX_HASH,
    process.env.PERPL_WITHDRAW_TX_HASH,
  ];
  if (hashes.some(Boolean) && hashes.some((hash) => !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash))) {
    throw new Error("Set all three PERPL_OPEN_TX_HASH, PERPL_CLOSE_TX_HASH, and PERPL_WITHDRAW_TX_HASH values");
  }

  let cycleEvents:
    | {
        openFillLotRaw: string;
        openFillFeeRaw: string;
        closeFillLotRaw: string;
        closeFillFeeRaw: string;
        builderFeesRaw: string;
        withdrawnRaw: string;
      }
    | undefined;
  if (hashes.every(Boolean)) {
    const [openReceipt, closeReceipt, withdrawReceipt] = await Promise.all([
      client.getTransactionReceipt({ hash: hashes[0] as Hex }),
      client.getTransactionReceipt({ hash: hashes[1] as Hex }),
      client.getTransactionReceipt({ hash: hashes[2] as Hex }),
    ]);
    if ([openReceipt, closeReceipt, withdrawReceipt].some((receipt) => receipt.status !== "success")) {
      throw new Error("A custody-cycle transaction reverted");
    }
    const exchangeLogs = (logs: typeof openReceipt.logs) =>
      logs.filter((log) => log.address.toLowerCase() === exchange.toLowerCase());
    const openRequests = parseEventLogs({
      abi: exchangeEventAbi, eventName: "OrderRequestV2", logs: exchangeLogs(openReceipt.logs),
    });
    const openPositions = parseEventLogs({
      abi: exchangeEventAbi, eventName: "PositionOpenedV2", logs: exchangeLogs(openReceipt.logs),
    });
    const openFills = parseEventLogs({
      abi: exchangeEventAbi, eventName: "TakerOrderFilledV2", logs: exchangeLogs(openReceipt.logs),
    });
    const closeRequests = parseEventLogs({
      abi: exchangeEventAbi, eventName: "OrderRequestV2", logs: exchangeLogs(closeReceipt.logs),
    });
    const closePositions = parseEventLogs({
      abi: exchangeEventAbi, eventName: "PositionClosed", logs: exchangeLogs(closeReceipt.logs),
    });
    const closeFills = parseEventLogs({
      abi: exchangeEventAbi, eventName: "TakerOrderFilledV2", logs: exchangeLogs(closeReceipt.logs),
    });
    const withdrawals = parseEventLogs({
      abi: exchangeEventAbi, eventName: "CollateralWithdrawal", logs: exchangeLogs(withdrawReceipt.logs),
    });

    const openRequest = openRequests.find((event) => event.args.accountId === account[0]
      && event.args.perpId === BigInt(btc.perpetual_id) && event.args.orderType === 0);
    const opened = openPositions.find((event) => event.args.accountId === account[0]
      && event.args.perpId === BigInt(btc.perpetual_id));
    const closeRequest = closeRequests.find((event) => event.args.accountId === account[0]
      && event.args.perpId === BigInt(btc.perpetual_id) && event.args.orderType === 2);
    const closed = closePositions.find((event) => event.args.accountId === account[0]
      && event.args.perpId === BigInt(btc.perpetual_id));
    const withdrawal = withdrawals.find((event) => event.args.accountId === account[0]);
    const openFill = openFills[0];
    const closeFill = closeFills[0];
    if (!openRequest || !opened || !openFill || !closeRequest || !closed || !closeFill || !withdrawal) {
      throw new Error("On-chain Perpl request, fill, position, close, or withdrawal event is missing");
    }
    if (opened.args.lotLNS !== openFill.args.lotLNS
      || closeFill.args.lotLNS !== opened.args.lotLNS
      || withdrawal.args.balanceCNS !== 0n) {
      throw new Error("Perpl custody-cycle event amounts do not reconcile");
    }
    cycleEvents = {
      openFillLotRaw: openFill.args.lotLNS.toString(),
      openFillFeeRaw: openFill.args.feeCNS.toString(),
      closeFillLotRaw: closeFill.args.lotLNS.toString(),
      closeFillFeeRaw: closeFill.args.feeCNS.toString(),
      builderFeesRaw: (openFill.args.builderFeeCNS + closeFill.args.builderFeeCNS).toString(),
      withdrawnRaw: withdrawal.args.amountCNS.toString(),
    };
  }
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    status: recovered ? "closed-and-recovered" : "not-fully-recovered",
    harness,
    harnessCodeBytes: (code.length - 2) / 2,
    owner,
    operator,
    exchange,
    collateral: collateralAddress,
    accountId: account[0].toString(),
    exchangeBalance: formatUnits(account[1], collateral.decimals),
    exchangeLockedBalance: formatUnits(account[2], collateral.decimals),
    btcPositionLotRaw: position[0].lotLNS.toString(),
    harnessIdleBalance: formatUnits(idle, collateral.decimals),
    ownerAusdBalance: formatUnits(ownerAusd, collateral.decimals),
    cycleEvents,
  }, null, 2));
  if (!recovered) process.exitCode = 1;
}

await main();
