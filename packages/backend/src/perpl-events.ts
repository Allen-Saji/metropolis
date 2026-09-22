import { parseAbi } from "viem";
export const exchangeEventAbi = parseAbi([
  "event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)",
  "event PositionOpenedV2(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 depositCNS,int256 pnlCollateralizedCNS,uint256 pricePNS,uint256 lotLNS,uint256 insFeeCNS,uint256 protFeeCNS,uint256 priceResiduePNSQ16)",
  "event TakerOrderFilledV2(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)",
  "event PositionClosed(uint256 perpId,uint256 accountId,uint8 positionType,uint256 pricePNS,int256 deltaPnlCNS,int256 fundingCNS)",
  "event CollateralWithdrawal(uint256 accountId,uint256 amountCNS,uint256 balanceCNS)",
]);
