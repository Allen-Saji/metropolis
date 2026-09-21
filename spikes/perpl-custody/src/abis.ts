import { parseAbi } from "viem";

export const exchangeReadAbi = parseAbi([
  "function getMinAccountOpenCNS() view returns (uint256)",
  "function getAccountByAddr(address accountAddress) view returns ((uint256 accountId,uint256 balanceCNS,uint256 lockedBalanceCNS,uint8 frozen,address accountAddr,(uint256 bank1,uint256 bank2,uint256 bank3,uint256 bank4) positions) accountInfo)",
  "function getPositionV2(uint256 perpId,uint256 accountId) view returns ((uint256 accountId,uint256 nextNodeId,uint256 prevNodeId,uint8 positionType,uint256 depositCNS,uint256 pricePNS,uint256 lotLNS,uint256 entryBlock,int256 pnlCNS,int256 deltaPnlCNS,int256 premiumPnlCNS,uint256 priceResiduePNSQ16) positionInfo,uint256 markPricePNS,bool markPriceValid)",
]);

export const exchangeEventAbi = parseAbi([
  "event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)",
  "event PositionOpenedV2(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 depositCNS,int256 pnlCollateralizedCNS,uint256 pricePNS,uint256 lotLNS,uint256 insFeeCNS,uint256 protFeeCNS,uint256 priceResiduePNSQ16)",
  "event TakerOrderFilledV2(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)",
  "event PositionClosed(uint256 perpId,uint256 accountId,uint8 positionType,uint256 pricePNS,int256 deltaPnlCNS,int256 fundingCNS)",
  "event CollateralWithdrawal(uint256 accountId,uint256 amountCNS,uint256 balanceCNS)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

export const ausdFaucetAbi = parseAbi([
  "function requestFunds(address recipient)",
  "function faucetDripAmount() view returns (uint256)",
  "function maxAmountToOwn() view returns (uint256)",
]);

export const delegatedAccountFactoryAbi = parseAbi([
  "function beacon() view returns (address)",
  "function EXCHANGE() view returns (address)",
]);

export const upgradeableBeaconAbi = parseAbi([
  "function implementation() view returns (address)",
  "function owner() view returns (address)",
]);

export const harnessAbi = parseAbi([
  "error Unauthorized()",
  "error InvalidExtension()",
  "constructor(address exchange,address collateral,address operator,uint256 maxLotLNS,uint256 maxAmountCNS)",
  "function openAccount(uint256 amountCNS) returns (uint256 accountId)",
  "function deposit(uint256 amountCNS)",
  "function setOrderForwarding(bool allowed)",
  "function executeOrder((uint256 orderDescId,uint256 perpId,uint8 orderType,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS) orderDesc,bytes extension) returns (uint256 perpId,uint256 orderId)",
  "function withdrawToOwner(uint256 amountCNS)",
  "function recoverIdleCollateral(uint256 amountCNS)",
  "function idleCollateral() view returns (uint256)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function exchange() view returns (address)",
  "function collateral() view returns (address)",
  "function account() view returns (uint256 accountId,uint256 balanceCNS,uint256 lockedBalanceCNS,uint8 frozen,address accountAddr)",
]);
