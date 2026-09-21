import {
  createPublicClient,
  formatUnits,
  http,
  toFunctionSelector,
  type Address,
} from "viem";
import { defineChain } from "viem/utils";
import {
  ausdFaucetAbi,
  delegatedAccountFactoryAbi,
  erc20Abi,
  exchangeReadAbi,
  upgradeableBeaconAbi,
} from "./abis.js";
import { DEFAULTS, fetchPerplContext, primaryInstance } from "./config.js";

const chain = defineChain({
  id: DEFAULTS.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl] } },
});

async function main() {
  const context = await fetchPerplContext();
  const { instance, collateral } = primaryInstance(context);
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const chainId = await client.getChainId();
  if (chainId !== DEFAULTS.chainId) {
    throw new Error(`Wrong chain: expected ${DEFAULTS.chainId}, received ${chainId}`);
  }

  const exchange = instance.address as Address;
  const collateralAddress = collateral.address as Address;
  const factory = DEFAULTS.delegatedAccountFactory as Address;
  const ausdFaucet = DEFAULTS.ausdFaucet as Address;
  const [exchangeCode, collateralCode, factoryCode, ausdFaucetCode, minOpen, decimals, symbol, factoryExchange, beacon] = await Promise.all([
    client.getBytecode({ address: exchange }),
    client.getBytecode({ address: collateralAddress }),
    client.getBytecode({ address: factory }),
    client.getBytecode({ address: ausdFaucet }),
    client.readContract({ address: exchange, abi: exchangeReadAbi, functionName: "getMinAccountOpenCNS" }),
    client.readContract({ address: collateralAddress, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: collateralAddress, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: factory, abi: delegatedAccountFactoryAbi, functionName: "EXCHANGE" }),
    client.readContract({ address: factory, abi: delegatedAccountFactoryAbi, functionName: "beacon" }),
  ]);

  if (!exchangeCode || !collateralCode || !factoryCode || !ausdFaucetCode) {
    throw new Error("Live Perpl or AUSD contracts have no bytecode");
  }
  if (factoryExchange.toLowerCase() !== exchange.toLowerCase()) {
    throw new Error("Perpl delegated-account factory points at a different exchange");
  }

  const [beaconCode, beaconImplementation, beaconOwner] = await Promise.all([
    client.getBytecode({ address: beacon }),
    client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "implementation" }),
    client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "owner" }),
  ]);
  const [implementationCode, beaconOwnerCode] = await Promise.all([
    client.getBytecode({ address: beaconImplementation }),
    client.getBytecode({ address: beaconOwner }),
  ]);
  const [faucetDripAmount, faucetMaxAmountToOwn] = await Promise.all([
    client.readContract({ address: ausdFaucet, abi: ausdFaucetAbi, functionName: "faucetDripAmount" }),
    client.readContract({ address: ausdFaucet, abi: ausdFaucetAbi, functionName: "maxAmountToOwn" }),
  ]);
  if (!beaconCode || !implementationCode) {
    throw new Error("Perpl delegated-account beacon or implementation has no bytecode");
  }
  if (Number(decimals) !== collateral.decimals || symbol !== collateral.symbol) {
    throw new Error("Perpl API context disagrees with the live collateral contract");
  }
  if (minOpen !== BigInt(instance.min_account_open_amount)) {
    throw new Error("Perpl API context disagrees with the live exchange minimum");
  }

  const btc = context.markets.find((market) => market.symbol === "BTC");
  const eth = context.markets.find((market) => market.symbol === "ETH");
  if (!btc || !eth) throw new Error("BTC or ETH market missing from Perpl Testnet");

  const observation = {
    observedAt: new Date().toISOString(),
    chainId,
    rpcUrl: new URL(rpcUrl).origin,
    apiUrl: new URL(process.env.PERPL_API_URL ?? DEFAULTS.apiUrl).origin,
    exchange,
    exchangeCodeBytes: (exchangeCode.length - 2) / 2,
    delegatedAccount: {
      factory,
      factoryCodeBytes: (factoryCode.length - 2) / 2,
      beacon,
      beaconCodeBytes: (beaconCode.length - 2) / 2,
      implementation: beaconImplementation,
      implementationCodeBytes: (implementationCode.length - 2) / 2,
      beaconOwner,
      beaconOwnerKind: beaconOwnerCode ? "contract" : "externally-owned account",
      trustBoundary: "The beacon owner can replace the implementation used by every factory-created account.",
      currentTradeSelector: toFunctionSelector(
        "execOrder((uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256))",
      ),
      builderTradeSelector: toFunctionSelector(
        "execOrderV2((uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256),bytes)",
      ),
      withdrawalSelector: toFunctionSelector("withdrawCollateral(uint256)"),
    },
    collateral: {
      address: collateralAddress,
      symbol,
      decimals: Number(decimals),
      codeBytes: (collateralCode.length - 2) / 2,
      minimumAccountOpenRaw: minOpen.toString(),
      minimumAccountOpenDisplay: `${formatUnits(minOpen, Number(decimals))} ${symbol}`,
      minimumDepositRaw: instance.min_deposit_amount,
      minimumWithdrawRaw: instance.min_withdraw_amount,
      faucet: {
        address: ausdFaucet,
        codeBytes: (ausdFaucetCode.length - 2) / 2,
        dripRaw: faucetDripAmount.toString(),
        dripDisplay: `${formatUnits(faucetDripAmount, Number(decimals))} ${symbol}`,
        maximumBalanceToRequestRaw: faucetMaxAmountToOwn.toString(),
        maximumBalanceToRequestDisplay: `${formatUnits(faucetMaxAmountToOwn, Number(decimals))} ${symbol}`,
      },
    },
    markets: [btc, eth].map((market) => ({
      id: market.id,
      symbol: market.symbol,
      priceDecimals: market.config.price_decimals,
      sizeDecimals: market.config.size_decimals,
      bidRaw: market.state.bid,
      askRaw: market.state.ask,
      markRaw: market.state.mrk,
      orderTtlBlocks: market.order_ttl_blocks,
      maxMarketSlippageBps: market.order_max_market_slippage_bps,
      maxNegativePnlCollateralBps: market.order_max_neg_pnl_collat_bps,
    })),
    provenCapabilities: [
      "live public context",
      "live exchange bytecode",
      "live collateral bytecode",
      "on-chain minimum account deposit",
      "BTC and ETH testnet markets",
      "official delegated-account factory, beacon, and implementation",
      "official AUSD testnet faucet contract",
    ],
  };

  console.log(JSON.stringify(observation, null, 2));
}

await main();
