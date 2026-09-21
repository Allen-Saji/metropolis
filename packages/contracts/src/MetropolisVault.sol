// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";
import {PerplAdapter} from "./PerplAdapter.sol";
import {RiskController} from "./RiskController.sol";
import {QualificationRegistry} from "./QualificationRegistry.sol";

/// @notice Testnet vault with settled-window conversions. Deliberately not ERC-4626.
contract MetropolisVault is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error WrongState();
    error Unauthorized();
    error InvalidInput();
    error Slippage();
    error Unqualified();
    error Insolvent();
    enum State {
        Settled,
        Trading,
        Settling
    }
    State public state;
    IERC20 public immutable asset;
    IPerplExchange public immutable exchange;
    PerplAdapter public immutable adapter;
    RiskController public immutable risk;
    QualificationRegistry public immutable registry;
    bytes32 public immutable requiredSuite;
    uint256 public constant EXIT_WINDOW = 1 hours;
    uint256 public settledUntil;
    uint256 public activeAgentId;
    address public operator;
    uint256 public highWaterEquity;
    uint256 public nextOrderId = 1;
    bool public paused;

    event Deposited(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
    event Redeemed(address indexed sender, address indexed receiver, uint256 shares, uint256 assets);
    event AgentActivated(uint256 indexed agentId, address indexed operator);
    event StateChanged(State indexed state);
    event TradeExecuted(uint256 indexed requestId, uint256 indexed market, uint8 orderType);
    event CollateralRecovered(uint256 amount);
    event PauseChanged(bool paused);

    constructor(
        IERC20 asset_,
        IPerplExchange exchange_,
        QualificationRegistry registry_,
        bytes32 suite_,
        address manager
    ) ERC20("Metropolis AUSD Share", "mAUSD") Ownable(manager) {
        if (
            address(asset_).code.length == 0 || address(exchange_).code.length == 0
                || address(registry_).code.length == 0 || suite_ == bytes32(0)
                || IERC20Metadata(address(asset_)).decimals() != 6
        ) revert InvalidInput();
        asset = asset_;
        exchange = exchange_;
        registry = registry_;
        requiredSuite = suite_;
        adapter = new PerplAdapter(asset_, exchange_);
        risk = new RiskController(exchange_, asset_);
        settledUntil = block.timestamp + EXIT_WINDOW;
    }

    function decimals() public pure override returns (uint8) {
        return 12;
    }

    /// @notice Available only when settled; excludes live position estimates by design.
    function settledAssets() public view returns (uint256) {
        if (state != State.Settled) revert WrongState();
        return asset.balanceOf(address(this)) + asset.balanceOf(address(adapter));
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 available = settledAssets();
        if (totalSupply() != 0 && available == 0) revert Insolvent();
        return Math.mulDiv(assets, totalSupply() + 1e6, available + 1);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, settledAssets() + 1, totalSupply() + 1e6);
    }

    function deposit(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (paused || state != State.Settled) revert WrongState();
        if (assets == 0 || receiver == address(0) || receiver == address(this) || receiver == address(adapter)) {
            revert InvalidInput();
        }
        shares = previewDeposit(assets);
        if (shares == 0 || shares < minShares) revert Slippage();
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        if (asset.balanceOf(address(this)) - beforeBalance != assets) revert InvalidInput();
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, uint256 minAssets)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (state != State.Settled) revert WrongState();
        if (shares == 0 || receiver == address(0) || receiver == address(this) || receiver == address(adapter)) {
            revert InvalidInput();
        }
        assets = previewRedeem(shares);
        if (assets < minAssets) revert Slippage();
        _burn(msg.sender, shares);
        adapter.recoverIdle();
        asset.safeTransfer(receiver, assets);
        emit Redeemed(msg.sender, receiver, shares, assets);
    }

    function activateAgent(uint256 agentId, address operator_) external onlyOwner {
        if (state != State.Settled) revert WrongState();
        if (!registry.isQualified(agentId, operator_, requiredSuite)) revert Unqualified();
        activeAgentId = agentId;
        operator = operator_;
        emit AgentActivated(agentId, operator_);
    }

    function startTrading(uint256 assets) external onlyOwner nonReentrant {
        if (paused || state != State.Settled || block.timestamp < settledUntil) revert WrongState();
        if (totalSupply() == 0 || assets == 0 || assets > settledAssets()) revert InvalidInput();
        _requireQualified();
        adapter.recoverIdle();
        highWaterEquity = asset.balanceOf(address(this));
        state = State.Trading;
        asset.safeTransfer(address(adapter), assets);
        adapter.fund(assets);
        emit StateChanged(state);
    }

    function executeTrade(IPerplExchange.OrderDesc calldata order) external nonReentrant {
        if (msg.sender != operator) revert Unauthorized();
        if (state != State.Trading && state != State.Settling) revert WrongState();
        bool opening = order.orderType < 2;
        if (opening && (paused || state != State.Trading)) revert WrongState();
        if (order.orderDescId != nextOrderId) revert InvalidInput();
        uint256 notional = risk.validateOrder(order);
        if (opening) {
            _requireQualified();
            RiskController.Snapshot memory beforeState = risk.snapshot(address(this), address(adapter));
            highWaterEquity = Math.max(highWaterEquity, beforeState.equity);
            risk.validateOpen(beforeState, order.perpId, notional, highWaterEquity);
        }
        ++nextOrderId;
        adapter.execute(order);
        if (opening) {
            RiskController.Snapshot memory afterState = risk.snapshot(address(this), address(adapter));
            risk.validateExposure(afterState, highWaterEquity);
            highWaterEquity = Math.max(highWaterEquity, afterState.equity);
        }
        emit TradeExecuted(order.orderDescId, order.perpId, order.orderType);
    }

    function requestSettlement() external {
        if (msg.sender != owner() && balanceOf(msg.sender) == 0) revert Unauthorized();
        if (state != State.Trading) revert WrongState();
        _settle();
    }

    /// @notice Anyone can record a risk breach or unreadable risk state and stop new exposure.
    function checkpointRisk() external nonReentrant {
        if (state != State.Trading) revert WrongState();
        try risk.snapshot(address(this), address(adapter)) returns (RiskController.Snapshot memory s) {
            try risk.validateExposure(s, highWaterEquity) {
                highWaterEquity = Math.max(highWaterEquity, s.equity);
            } catch {
                _settle();
            }
        } catch {
            _settle();
        }
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        if (value && state == State.Trading) _settle();
        emit PauseChanged(value);
    }

    /// @notice Permissionless close using a fixed 1% price bound, never caller-supplied execution prices.
    function closePosition(uint256 perpId) external nonReentrant {
        if (state != State.Settling) revert WrongState();
        IPerplExchange.AccountInfo memory a = exchange.getAccountByAddr(address(adapter));
        (IPerplExchange.PositionInfoV2 memory p,, bool valid) = exchange.getPositionV2(perpId, a.accountId);
        if (!valid || p.lotLNS == 0 || p.accountId != a.accountId || p.positionType > 1) revert InvalidInput();
        (uint256 mark,) = risk.market(perpId);
        IPerplExchange.OrderDesc memory o;
        o.orderDescId = nextOrderId++;
        o.perpId = perpId;
        o.orderType = p.positionType == 0 ? 2 : 3;
        o.pricePNS = Math.mulDiv(mark, p.positionType == 0 ? 9900 : 10100, 10000);
        o.lotLNS = p.lotLNS;
        o.immediateOrCancel = true;
        o.maxMatches = 20;
        o.leverageHdths = 200;
        o.lastExecutionBlock = block.number + 20;
        o.maxNegPnlCollatBPS = 1000;
        adapter.execute(o);
        emit TradeExecuted(o.orderDescId, perpId, o.orderType);
    }

    function recoverCollateral(uint256 assets) external nonReentrant {
        if (state != State.Settling) revert WrongState();
        adapter.recover(assets);
        emit CollateralRecovered(assets);
    }

    function finishSettlement() external nonReentrant {
        if (state != State.Settling) revert WrongState();
        adapter.assertFlat();
        if (exchange.getAccountByAddr(address(adapter)).balanceCNS != 0) revert WrongState();
        adapter.recoverIdle();
        state = State.Settled;
        settledUntil = block.timestamp + EXIT_WINDOW;
        emit StateChanged(state);
    }

    function _settle() private {
        state = State.Settling;
        emit StateChanged(state);
    }

    function _requireQualified() private view {
        if (operator == address(0) || !registry.isQualified(activeAgentId, operator, requiredSuite)) {
            revert Unqualified();
        }
    }
}
