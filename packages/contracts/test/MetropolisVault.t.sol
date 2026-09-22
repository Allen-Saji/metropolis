// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MetropolisVault} from "../src/MetropolisVault.sol";
import {PerplAdapter} from "../src/PerplAdapter.sol";
import {QualificationRegistry} from "../src/QualificationRegistry.sol";
import {RiskController} from "../src/RiskController.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";
import {Vm, TestAsset, TestIdentity, TestExchange} from "./Fixtures.sol";

contract MetropolisVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestAsset asset;
    TestIdentity identity;
    TestExchange exchange;
    QualificationRegistry registry;
    MetropolisVault vault;
    address constant ALICE = address(0xa11ce);
    address constant BOB = address(0xb0b);
    address constant OPERATOR = address(0x1234);
    bytes32 constant SUITE = keccak256("qualification-v1");

    function setUp() public {
        vm.warp(1_000_000);
        asset = new TestAsset();
        identity = new TestIdentity();
        identity.setOwner(7, ALICE);
        exchange = new TestExchange(asset);
        registry = new QualificationRegistry(identity, address(this));
        registry.record(7, OPERATOR, SUITE, keccak256("evidence"), uint64(block.timestamp + 7 days), true);
        vault = new MetropolisVault(asset, exchange, registry, SUITE, address(this));
        asset.mint(ALICE, 10_000e6);
        asset.mint(BOB, 10_000e6);
        vm.prank(ALICE);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        asset.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return vault.deposit(amount, who, 1);
    }

    function _start() internal {
        _deposit(ALICE, 1000e6);
        vault.activateAgent(7, OPERATOR);
        vm.warp(block.timestamp + 1 hours);
        vault.startTrading(1000e6);
    }

    function _order(uint256 lot, uint8 side) internal view returns (IPerplExchange.OrderDesc memory o) {
        o.orderDescId = vault.nextOrderId();
        o.perpId = 16;
        o.orderType = side;
        o.pricePNS = 100_000;
        o.lotLNS = lot;
        o.immediateOrCancel = true;
        o.maxMatches = 10;
        o.leverageHdths = 200;
        o.lastExecutionBlock = block.number + 10;
    }

    function _open(uint256 lot) internal {
        IPerplExchange.OrderDesc memory o = _order(lot, 0);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
    }

    function testDepositRedeemAndVaultOwnership() public {
        uint256 shares = _deposit(ALICE, 100e6);
        require(shares == 100e12 && vault.adapter().vault() == address(vault));
        vm.prank(ALICE);
        uint256 returned = vault.redeem(shares, ALICE, 100e6);
        require(returned == 100e6 && vault.totalSupply() == 0);
    }

    function testMultipleDepositorsRealizedLossAndAgentIndependentRecovery() public {
        uint256 a = _deposit(ALICE, 1000e6);
        uint256 b = _deposit(BOB, 1000e6);
        vault.activateAgent(7, OPERATOR);
        vm.warp(block.timestamp + 1 hours);
        vault.startTrading(2000e6);
        _open(200);
        exchange.setPnl(address(vault.adapter()), 16, -20e6);
        vm.prank(ALICE);
        vault.requestSettlement();
        vm.prank(BOB);
        vault.closePosition(16);
        vault.recoverCollateral(1980e6);
        vault.finishSettlement();
        vm.prank(ALICE);
        uint256 paidA = vault.redeem(a, ALICE, 989e6);
        vm.prank(BOB);
        uint256 paidB = vault.redeem(b, BOB, 989e6);
        require(paidA >= 990e6 - 1 && paidA <= 990e6);
        require(paidB >= 990e6 - 1 && paidB <= 990e6);
        require(asset.balanceOf(address(vault)) <= 2);
    }

    function testTradingAndSettlingBlockShareConversions() public {
        _start();
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vm.prank(BOB);
        vault.deposit(1e6, BOB, 1);
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vm.prank(ALICE);
        vault.redeem(1, ALICE, 0);
        vm.prank(ALICE);
        vault.requestSettlement();
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vm.prank(BOB);
        vault.deposit(1e6, BOB, 1);
    }

    function testQualificationExpiryRevocationAndOwnerChangeBlockNewExposure() public {
        _start();
        identity.setOwner(7, BOB);
        IPerplExchange.OrderDesc memory o = _order(10, 0);
        vm.expectRevert(MetropolisVault.Unqualified.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        identity.setOwner(7, ALICE);
        registry.record(7, OPERATOR, SUITE, keccak256("fail"), 0, false);
        vm.expectRevert(MetropolisVault.Unqualified.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        registry.record(7, OPERATOR, SUITE, keccak256("pass"), uint64(block.timestamp + 1), true);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(MetropolisVault.Unqualified.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
    }

    function testUnqualifiedActivationAndUnauthorizedAttestation() public {
        vm.expectRevert(MetropolisVault.Unqualified.selector);
        vault.activateAgent(7, BOB);
        vm.expectRevert();
        vm.prank(BOB);
        registry.record(7, BOB, SUITE, bytes32(uint256(1)), uint64(block.timestamp + 1 days), true);
    }

    function testOperatorCannotWithdrawOrCallAdapterDirectly() public {
        _start();
        PerplAdapter adapter = vault.adapter();
        vm.expectRevert(PerplAdapter.Unauthorized.selector);
        vm.prank(OPERATOR);
        adapter.recover(1);
        IPerplExchange.OrderDesc memory o = _order(10, 0);
        vm.expectRevert(PerplAdapter.Unauthorized.selector);
        vm.prank(OPERATOR);
        adapter.execute(o);
        vm.expectRevert();
        vm.prank(OPERATOR);
        vault.startTrading(1);
    }

    function testOrderLimitAndAggregateLimit() public {
        _start();
        IPerplExchange.OrderDesc memory o = _order(251, 0);
        vm.expectRevert(RiskController.RiskLimit.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        for (uint256 i; i < 4; ++i) {
            _open(250);
        }
        o = _order(1, 0);
        vm.expectRevert(RiskController.RiskLimit.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
    }

    function testInvalidOrderModesPriceAndReplay() public {
        _start();
        IPerplExchange.OrderDesc memory o = _order(10, 0);
        o.immediateOrCancel = false;
        vm.expectRevert(PerplAdapter.InvalidOrder.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        o.immediateOrCancel = true;
        o.leverageHdths = 201;
        vm.expectRevert(RiskController.InvalidOrder.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        o.leverageHdths = 200;
        o.pricePNS = 102_000;
        vm.expectRevert(RiskController.RiskLimit.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        o.pricePNS = 100_000;
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        vm.expectRevert(MetropolisVault.InvalidInput.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
    }

    function testUnexpectedResidualOrdersRevertEntireTrade() public {
        _start();
        exchange.setLeaveOrderAfterExecution();
        IPerplExchange.OrderDesc memory o = _order(10, 0);
        vm.expectRevert(PerplAdapter.Unsettled.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        require(exchange.calls() == 0);
    }

    function testDrawdownBreachMovesToSettlementAndPreservesCloseAccess() public {
        _start();
        _open(250);
        exchange.setPnl(address(vault.adapter()), 16, -110e6);
        vault.checkpointRisk();
        require(vault.state() == MetropolisVault.State.Settling);
        IPerplExchange.OrderDesc memory o = _order(1, 0);
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        vault.closePosition(16);
        vault.recoverCollateral(890e6);
        vault.finishSettlement();
        require(vault.settledAssets() == 890e6);
    }

    function testStaleOrInvalidMarksStopNewExposure() public {
        _start();
        _open(10);
        exchange.configure(true, false, false, false);
        IPerplExchange.OrderDesc memory o = _order(1, 0);
        vm.expectRevert(RiskController.UnsafeState.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        exchange.configure(false, true, false, false);
        vm.expectRevert(RiskController.UnsafeState.selector);
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        vault.checkpointRisk();
        require(vault.state() == MetropolisVault.State.Settling);
    }

    function testCannotFinishWithPositionsOrCollateralRemaining() public {
        _start();
        _open(10);
        vault.requestSettlement();
        vm.expectRevert(PerplAdapter.Unsettled.selector);
        vault.finishSettlement();
        vault.closePosition(16);
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vault.finishSettlement();
        exchange.configure(false, false, false, true);
        vm.expectRevert();
        vault.recoverCollateral(1000e6);
        require(vault.state() == MetropolisVault.State.Settling);
        exchange.configure(false, false, false, false);
        vault.recoverCollateral(400e6);
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vault.finishSettlement();
        vault.recoverCollateral(600e6);
        vault.finishSettlement();
    }

    function testExitWindowAndPausedRedemptions() public {
        _start();
        vault.setPaused(true);
        vault.recoverCollateral(1000e6);
        vault.finishSettlement();
        vault.setPaused(false);
        vm.expectRevert(MetropolisVault.WrongState.selector);
        vault.startTrading(1000e6);
        vault.setPaused(true);
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(shares, ALICE, 1000e6);
    }

    function testDonationsCannotBypassMinimumSharesAndAdapterDustDoesNotBlockExit() public {
        _deposit(ALICE, 1);
        vm.prank(ALICE);
        asset.transfer(address(vault), 1000e6);
        vm.expectRevert(MetropolisVault.Slippage.selector);
        vm.prank(BOB);
        vault.deposit(100e6, BOB, 100e12);
        asset.mint(address(vault.adapter()), 3);
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(shares, ALICE, 1);
        require(asset.balanceOf(address(vault.adapter())) == 0);
    }

    function testUnknownPositionBlocksSettlement() public {
        _start();
        exchange.injectUnknownPosition(address(vault.adapter()));
        vault.requestSettlement();
        vm.expectRevert(PerplAdapter.Unsettled.selector);
        vault.finishSettlement();
    }

    function testTotalLossBurnThenRecapitalization() public {
        _start();
        exchange.setBalance(address(vault.adapter()), 0);
        vault.requestSettlement();
        vault.finishSettlement();
        vm.expectRevert(MetropolisVault.Insolvent.selector);
        vm.prank(BOB);
        vault.deposit(100e6, BOB, 1);
        uint256 shares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        require(vault.redeem(shares, ALICE, 0) == 0);
        require(_deposit(BOB, 100e6) == 100e12);
    }

    function testFuzzRoundTripNeverCreatesAssets(uint64 rawA, uint64 rawB) public {
        uint256 a = uint256(rawA) % 10_000e6 + 1;
        uint256 b = uint256(rawB) % 10_000e6 + 1;
        asset.mint(ALICE, 1);
        asset.mint(BOB, 1);
        uint256 sharesA = _deposit(ALICE, a);
        uint256 sharesB = _deposit(BOB, b);
        vm.prank(ALICE);
        uint256 paidA = vault.redeem(sharesA, ALICE, 0);
        vm.prank(BOB);
        uint256 paidB = vault.redeem(sharesB, BOB, 0);
        require(paidA <= a && paidB <= b);
        require(paidA + paidB + vault.settledAssets() == a + b);
    }

    function testRepeatedTradingEpochReusesAccount() public {
        _start();
        uint256 id = vault.adapter().accountId();
        vault.requestSettlement();
        vault.recoverCollateral(1000e6);
        vault.finishSettlement();
        vm.warp(block.timestamp + 1 hours);
        vault.startTrading(500e6);
        require(vault.adapter().accountId() == id);
        require(exchange.getAccountByAddr(address(vault.adapter())).balanceCNS == 500e6);
    }

    function testFuzzSettledLossIsSharedProportionally(uint32 rawA, uint32 rawB, uint16 rawLoss) public {
        uint256 a = uint256(rawA) % 1000e6 + 1e6;
        uint256 b = uint256(rawB) % 1000e6 + 1e6;
        uint256 sa = _deposit(ALICE, a);
        uint256 sb = _deposit(BOB, b);
        vault.activateAgent(7, OPERATOR);
        vm.warp(block.timestamp + 1 hours);
        vault.startTrading(a + b);
        uint256 remaining = (a + b) * (10000 - uint256(rawLoss) % 10000) / 10000;
        exchange.setBalance(address(vault.adapter()), remaining);
        vault.requestSettlement();
        vault.recoverCollateral(remaining);
        vault.finishSettlement();
        vm.prank(ALICE);
        uint256 pa = vault.redeem(sa, ALICE, 0);
        vm.prank(BOB);
        uint256 pb = vault.redeem(sb, BOB, 0);
        uint256 expectedA = remaining * a / (a + b);
        uint256 expectedB = remaining * b / (a + b);
        require(pa <= expectedA + 1 && pa + 1 >= expectedA);
        require(pb <= expectedB + 1 && pb + 1 >= expectedB);
        require(pa + pb + vault.settledAssets() == remaining);
    }

    function testWrongSuiteCannotActivate() public {
        registry.record(
            7, OPERATOR, keccak256("other-suite"), keccak256("evidence"), uint64(block.timestamp + 1 days), true
        );
        vm.expectRevert(MetropolisVault.Unqualified.selector);
        vault.activateAgent(7, OPERATOR);
    }

    function testNonHolderCannotRequestSettlementButCanRecover() public {
        _start();
        vm.expectRevert(MetropolisVault.Unauthorized.selector);
        vm.prank(BOB);
        vault.requestSettlement();
        vault.requestSettlement();
        vm.prank(BOB);
        vault.recoverCollateral(1000e6);
        vm.prank(BOB);
        vault.finishSettlement();
    }

    function testDelayedQualificationCannotTransferToNewIdentityOwner() public {
        identity.setOwner(7, BOB);
        vm.expectRevert(QualificationRegistry.InvalidQualification.selector);
        registry.recordForOwner(
            7, ALICE, OPERATOR, SUITE, keccak256("queued-evidence"), uint64(block.timestamp + 1 days), true
        );
        require(!registry.isQualified(7, OPERATOR, SUITE));
        registry.recordForOwner(
            7, BOB, OPERATOR, SUITE, keccak256("new-consent"), uint64(block.timestamp + 1 days), true
        );
        require(registry.isQualified(7, OPERATOR, SUITE));
    }
}
