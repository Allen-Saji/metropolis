// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";

/// @notice Fixed V1 policy for six-decimal AUSD, BTC (16) and ETH (32).
contract RiskController {
    using SafeCast for uint256;
    using SafeCast for int256;
    error UnsafeState();
    error RiskLimit();
    error InvalidOrder();
    uint256 public constant MAX_PRICE_AGE = 60;
    uint256 public constant MAX_SLIPPAGE_BPS = 100;
    IPerplExchange public immutable exchange;
    IERC20 public immutable asset;

    struct Snapshot {
        uint256 equity;
        uint256 btcNotional;
        uint256 ethNotional;
    }

    constructor(IPerplExchange exchange_, IERC20 asset_) {
        exchange = exchange_;
        asset = asset_;
    }

    function market(uint256 perpId) public view returns (uint256 mark, uint256 scale) {
        if (perpId != 16 && perpId != 32) revert InvalidOrder();
        IPerplExchange.PerpetualInfoV2 memory p = exchange.getPerpetualInfoV2(perpId);
        if (
            p.markPNS == 0 || p.markTimestamp > block.timestamp || block.timestamp - p.markTimestamp > MAX_PRICE_AGE
                || p.priceDecimals > 18 || p.lotDecimals > 18
        ) revert UnsafeState();
        return (p.markPNS, 10 ** (p.priceDecimals + p.lotDecimals));
    }

    function snapshot(address vault, address adapter) public view returns (Snapshot memory s) {
        IPerplExchange.AccountInfo memory a = exchange.getAccountByAddr(adapter);
        uint256 allowed = (uint256(1) << 16) | (uint256(1) << 32);
        if (
            a.frozen != 0 || (a.positions.bank1 & (type(uint256).max >> 3) & ~allowed) != 0 || a.positions.bank2 != 0
                || a.positions.bank3 != 0 || a.positions.bank4 != 0 || a.lockedBalanceCNS != 0
                || exchange.getOrderLocks(a.accountId).length != 0
        ) revert UnsafeState();
        int256 equity = (asset.balanceOf(vault) + asset.balanceOf(adapter) + a.balanceCNS).toInt256();
        for (uint256 i; i < 2; ++i) {
            uint256 perpId = i == 0 ? 16 : 32;
            if (a.positions.bank1 & (uint256(1) << perpId) == 0) continue;
            (IPerplExchange.PositionInfoV2 memory p, uint256 mark, bool valid) =
                exchange.getPositionV2(perpId, a.accountId);
            (uint256 currentMark, uint256 scale) = market(perpId);
            if (
                !valid || mark != currentMark || p.accountId != a.accountId || p.lotLNS == 0
                    || p.pnlCNS != p.deltaPnlCNS + p.premiumPnlCNS
            ) revert UnsafeState();
            equity += p.depositCNS.toInt256() + p.pnlCNS;
            uint256 notional = Math.mulDiv(mark, p.lotLNS * 1e6, scale, Math.Rounding.Ceil);
            if (i == 0) s.btcNotional = notional;
            else s.ethNotional = notional;
        }
        if (equity <= 0) revert UnsafeState();
        s.equity = equity.toUint256();
    }

    function validateOrder(IPerplExchange.OrderDesc calldata o) public view returns (uint256 orderNotional) {
        if (
            o.orderType > 3 || o.lotLNS == 0 || o.lotLNS > type(uint40).max || o.pricePNS == 0
                || o.pricePNS > type(uint32).max || o.leverageHdths == 0 || o.leverageHdths > 200
                || o.maxNegPnlCollatBPS > 1000 || o.maxMatches == 0 || o.maxMatches > 20
                || o.lastExecutionBlock < block.number || o.lastExecutionBlock > block.number + 20
        ) revert InvalidOrder();
        (uint256 mark, uint256 scale) = market(o.perpId);
        // Bound both sides, including accidentally unreasonable limit prices.
        if (o.pricePNS < Math.mulDiv(mark, 9900, 10000) || o.pricePNS > Math.mulDiv(mark, 10100, 10000)) {
            revert RiskLimit();
        }
        return Math.mulDiv(Math.max(mark, o.pricePNS), o.lotLNS * 1e6, scale, Math.Rounding.Ceil);
    }

    function validateExposure(Snapshot memory s, uint256 highWater) public pure {
        if (
            s.equity < Math.mulDiv(highWater, 9000, 10000, Math.Rounding.Ceil) || s.btcNotional > s.equity
                || s.ethNotional > s.equity || s.btcNotional + s.ethNotional > 2 * s.equity
        ) revert RiskLimit();
    }

    function validateOpen(Snapshot memory s, uint256 perpId, uint256 addedNotional, uint256 highWater) external pure {
        validateExposure(s, highWater);
        if (addedNotional > s.equity / 4) revert RiskLimit();
        if (perpId == 16) s.btcNotional += addedNotional;
        else if (perpId == 32) s.ethNotional += addedNotional;
        else revert InvalidOrder();
        validateExposure(s, highWater);
    }
}
