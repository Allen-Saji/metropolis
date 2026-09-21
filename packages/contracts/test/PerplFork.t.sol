// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";
import {MetropolisVault} from "../src/MetropolisVault.sol";
import {QualificationRegistry} from "../src/QualificationRegistry.sol";
import {RiskController} from "../src/RiskController.sol";
import {Vm, TestIdentity} from "./Fixtures.sol";

/// @notice Runs entirely in a local EVM fork. No private key or live transaction.
contract PerplForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IPerplExchange constant EXCHANGE = IPerplExchange(0x1964C32f0bE608E7D29302AFF5E61268E72080cc);
    IERC20 constant ASSET = IERC20(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC);
    address constant SPIKE = 0xF628B42D22c3A2adDA10008c09Db4e708c527549;
    address constant FUNDER = 0x9d6E641a5a78254d644d0ACBa18385d930d877Fe;
    address constant OPERATOR = address(0x1234);

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc, 64497756);
        require(block.chainid == 10143);
        require(address(EXCHANGE).code.length > 0 && address(ASSET).code.length > 0);
    }

    function testHistoricalPositionValuationAgainstDeployedPerpl() public {
        RiskController risk = new RiskController(EXCHANGE, ASSET);
        RiskController.Snapshot memory s = risk.snapshot(address(0xbeef), SPIKE);
        require(s.equity == 99_942_379, "historical equity mismatch");
        require(s.btcNotional > 0 && s.ethNotional == 0);
    }

    function testVaultDepositTradeSettleRedeemAgainstDeployedPerpl() public {
        uint256 timestamp = block.timestamp;
        vm.warp(timestamp - 1 hours);
        TestIdentity identity = new TestIdentity();
        identity.setOwner(7, address(this));
        QualificationRegistry registry = new QualificationRegistry(identity, address(this));
        bytes32 suite = keccak256("qualification-v1");
        registry.record(7, OPERATOR, suite, keccak256("test-attestation"), uint64(timestamp + 1 days), true);
        MetropolisVault vault = new MetropolisVault(ASSET, EXCHANGE, registry, suite, address(this));
        vm.warp(timestamp);
        vm.prank(FUNDER);
        ASSET.transfer(address(this), 1000e6);
        ASSET.approve(address(vault), 1000e6);
        uint256 shares = vault.deposit(1000e6, address(this), 1000e12);
        vault.activateAgent(7, OPERATOR);
        vault.startTrading(1000e6);
        uint256 accountId = EXCHANGE.getAccountByAddr(address(vault.adapter())).accountId;
        IPerplExchange.PerpetualInfoV2 memory info = EXCHANGE.getPerpetualInfoV2(16);
        IPerplExchange.OrderDesc memory o;
        o.orderDescId = 1;
        o.perpId = 16;
        o.orderType = 0;
        o.lotLNS = 100;
        o.pricePNS = info.markPNS * 10100 / 10000;
        o.immediateOrCancel = true;
        o.maxMatches = 20;
        o.leverageHdths = 200;
        o.lastExecutionBlock = block.number + 20;
        o.maxNegPnlCollatBPS = 1000;
        vm.prank(OPERATOR);
        vault.executeTrade(o);
        (IPerplExchange.PositionInfoV2 memory p,,) = EXCHANGE.getPositionV2(16, accountId);
        require(p.lotLNS > 0, "order did not fill");
        vault.requestSettlement();
        vm.prank(address(0xbeef));
        vault.closePosition(16);
        (p,,) = EXCHANGE.getPositionV2(16, accountId);
        require(p.lotLNS == 0, "close did not fill");
        uint256 balance = EXCHANGE.getAccountByAddr(address(vault.adapter())).balanceCNS;
        vm.prank(address(0xbeef));
        vault.recoverCollateral(balance);
        vm.prank(address(0xbeef));
        vault.finishSettlement();
        uint256 received = vault.redeem(shares, address(this), 990e6);
        require(received >= 990e6 && received <= 1000e6);
        require(EXCHANGE.getAccountByAddr(address(vault.adapter())).balanceCNS == 0);
        require(ASSET.balanceOf(address(vault.adapter())) == 0);
    }
}
