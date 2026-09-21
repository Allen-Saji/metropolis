// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";

/// @notice Immutable vault custody. No operator, arbitrary-call, forwarding, or fee-extension path.
contract PerplAdapter {
    using SafeERC20 for IERC20;
    error Unauthorized();
    error InvalidOrder();
    error Unsettled();
    address public immutable vault;
    IERC20 public immutable asset;
    IPerplExchange public immutable exchange;
    uint256 public accountId;

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    constructor(IERC20 asset_, IPerplExchange exchange_) {
        vault = msg.sender;
        asset = asset_;
        exchange = exchange_;
    }

    function fund(uint256 amount) external onlyVault {
        asset.forceApprove(address(exchange), amount);
        // Perpl reverts on getAccountByAddr before registration; track creation locally.
        if (accountId == 0) accountId = exchange.createAccount(amount);
        else exchange.depositCollateral(amount);
        asset.forceApprove(address(exchange), 0);
    }

    function execute(IPerplExchange.OrderDesc calldata order) external onlyVault {
        if (
            (order.perpId != 16 && order.perpId != 32) || order.orderType > 3 || !order.immediateOrCancel
                || order.postOnly || order.fillOrKill || order.expiryBlock != 0 || order.orderId != 0
                || order.amountCNS != 0 || order.lotLNS == 0
        ) revert InvalidOrder();
        exchange.execOrderV2(order, "");
        // IOC must not leave residual order state, even if a venue implementation changes.
        IPerplExchange.AccountInfo memory account = exchange.getAccountByAddr(address(this));
        if (account.lockedBalanceCNS != 0 || exchange.getOrderLocks(account.accountId).length != 0) revert Unsettled();
    }

    function assertFlat() public view {
        if (accountId == 0) return;
        IPerplExchange.AccountInfo memory a = exchange.getAccountByAddr(address(this));
        // The SDK reserves the first bank's high three bits for metadata.
        if (
            (a.positions.bank1 & (type(uint256).max >> 3)) != 0 || a.positions.bank2 != 0 || a.positions.bank3 != 0
                || a.positions.bank4 != 0 || a.lockedBalanceCNS != 0 || exchange.getOrderLocks(a.accountId).length != 0
        ) revert Unsettled();
    }

    /// @notice Partial recovery supports venue withdrawal throttling. Recipient is always the vault.
    function recover(uint256 amount) external onlyVault {
        assertFlat();
        if (amount != 0) exchange.withdrawCollateral(amount);
        _recoverIdle();
    }

    function recoverIdle() external onlyVault {
        _recoverIdle();
    }

    function _recoverIdle() private {
        uint256 amount = asset.balanceOf(address(this));
        if (amount != 0) asset.safeTransfer(vault, amount);
    }
}
