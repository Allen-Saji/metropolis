// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IPerplExchange {
    struct PositionBitMap {
        uint256 bank1;
        uint256 bank2;
        uint256 bank3;
        uint256 bank4;
    }

    struct AccountInfo {
        uint256 accountId;
        uint256 balanceCNS;
        uint256 lockedBalanceCNS;
        uint8 frozen;
        address accountAddr;
        PositionBitMap positions;
    }

    struct OrderDesc {
        uint256 orderDescId;
        uint256 perpId;
        uint8 orderType;
        uint256 orderId;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 expiryBlock;
        bool postOnly;
        bool fillOrKill;
        bool immediateOrCancel;
        uint256 maxMatches;
        uint256 leverageHdths;
        uint256 lastExecutionBlock;
        uint256 amountCNS;
        uint256 maxNegPnlCollatBPS;
    }

    struct OrderSignature {
        uint256 perpId;
        uint256 orderId;
    }

    function createAccount(uint256 amountCNS) external returns (uint256 accountId);
    function depositCollateral(uint256 amountCNS) external;
    function withdrawCollateral(uint256 amountCNS) external;
    function allowOrderForwarding(bool allowed) external;
    function getAccountByAddr(address accountAddress) external view returns (AccountInfo memory);
    function execOrderV2(OrderDesc calldata orderDesc, bytes calldata extension)
        external
        returns (OrderSignature memory signature);
}

contract PerplCustodyHarness {
    error Unauthorized();
    error InvalidAddress();
    error InvalidMarket();
    error InvalidOrderType();
    error InvalidExtension();
    error RiskLimitExceeded();
    error TokenOperationFailed();
    error Reentrancy();

    event AccountOpened(uint256 indexed accountId, uint256 amountCNS);
    event CollateralDeposited(uint256 amountCNS);
    event CollateralWithdrawn(address indexed recipient, uint256 amountCNS);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OrderExecuted(uint256 indexed requestId, uint256 indexed perpId, uint256 orderId);

    uint256 internal constant BTC_PERP_ID = 16;
    uint256 internal constant ETH_PERP_ID = 32;
    uint256 internal constant MAX_LEVERAGE_HDTHS = 200;
    uint256 internal constant MAX_NEGATIVE_PNL_COLLATERAL_BPS = 1_000;
    uint8 internal constant CLOSE_LONG_ORDER_TYPE = 2;
    uint8 internal constant CLOSE_SHORT_ORDER_TYPE = 3;
    uint8 internal constant CANCEL_ORDER_TYPE = 4;

    address public immutable owner;
    IPerplExchange public immutable exchange;
    IERC20 public immutable collateral;
    uint256 public immutable maxLotLNS;
    uint256 public immutable maxAmountCNS;
    address public operator;
    uint256 private entered;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered == 1) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(
        address exchange_,
        address collateral_,
        address operator_,
        uint256 maxLotLNS_,
        uint256 maxAmountCNS_
    ) {
        if (exchange_ == address(0) || collateral_ == address(0) || operator_ == address(0)) {
            revert InvalidAddress();
        }
        owner = msg.sender;
        exchange = IPerplExchange(exchange_);
        collateral = IERC20(collateral_);
        operator = operator_;
        maxLotLNS = maxLotLNS_;
        maxAmountCNS = maxAmountCNS_;
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    function openAccount(uint256 amountCNS) external onlyOwner nonReentrant returns (uint256 accountId) {
        if (amountCNS == 0 || amountCNS > maxAmountCNS) revert RiskLimitExceeded();
        if (!collateral.approve(address(exchange), 0)) revert TokenOperationFailed();
        if (!collateral.approve(address(exchange), amountCNS)) revert TokenOperationFailed();
        accountId = exchange.createAccount(amountCNS);
        emit AccountOpened(accountId, amountCNS);
    }

    function deposit(uint256 amountCNS) external onlyOwner nonReentrant {
        if (amountCNS == 0 || amountCNS > maxAmountCNS) revert RiskLimitExceeded();
        if (!collateral.approve(address(exchange), 0)) revert TokenOperationFailed();
        if (!collateral.approve(address(exchange), amountCNS)) revert TokenOperationFailed();
        exchange.depositCollateral(amountCNS);
        emit CollateralDeposited(amountCNS);
    }

    function setOrderForwarding(bool allowed) external onlyOwner {
        exchange.allowOrderForwarding(allowed);
    }

    function executeOrder(IPerplExchange.OrderDesc calldata orderDesc, bytes calldata extension)
        external
        onlyOperator
        nonReentrant
        returns (IPerplExchange.OrderSignature memory signature)
    {
        // The V2 extension can attach an additive builder fee. The hot operator
        // must not be able to direct collateral to an arbitrary builder.
        if (extension.length != 0) revert InvalidExtension();
        if (orderDesc.perpId != BTC_PERP_ID && orderDesc.perpId != ETH_PERP_ID) {
            revert InvalidMarket();
        }
        if (orderDesc.orderType > CANCEL_ORDER_TYPE) revert InvalidOrderType();
        if (orderDesc.orderType < CANCEL_ORDER_TYPE) {
            if (
                orderDesc.lotLNS == 0 || orderDesc.lotLNS > maxLotLNS
                    || orderDesc.leverageHdths > MAX_LEVERAGE_HDTHS
                    || orderDesc.amountCNS > maxAmountCNS
                    || orderDesc.maxNegPnlCollatBPS > MAX_NEGATIVE_PNL_COLLATERAL_BPS
            ) revert RiskLimitExceeded();
            if (
                orderDesc.orderType < CLOSE_LONG_ORDER_TYPE
                    && orderDesc.leverageHdths == 0
            ) revert RiskLimitExceeded();
            if (
                (orderDesc.orderType == CLOSE_LONG_ORDER_TYPE
                    || orderDesc.orderType == CLOSE_SHORT_ORDER_TYPE)
                    && orderDesc.amountCNS != 0
            ) revert RiskLimitExceeded();
        }
        signature = exchange.execOrderV2(orderDesc, extension);
        emit OrderExecuted(orderDesc.orderDescId, signature.perpId, signature.orderId);
    }

    function withdrawToOwner(uint256 amountCNS) external onlyOwner nonReentrant {
        if (amountCNS == 0 || amountCNS > maxAmountCNS) revert RiskLimitExceeded();
        exchange.withdrawCollateral(amountCNS);
        if (!collateral.transfer(owner, amountCNS)) revert TokenOperationFailed();
        emit CollateralWithdrawn(owner, amountCNS);
    }

    function recoverIdleCollateral(uint256 amountCNS) external onlyOwner nonReentrant {
        if (!collateral.transfer(owner, amountCNS)) revert TokenOperationFailed();
        emit CollateralWithdrawn(owner, amountCNS);
    }

    function account()
        external
        view
        returns (
            uint256 accountId,
            uint256 balanceCNS,
            uint256 lockedBalanceCNS,
            uint8 frozen,
            address accountAddr
        )
    {
        IPerplExchange.AccountInfo memory info = exchange.getAccountByAddr(address(this));
        return (info.accountId, info.balanceCNS, info.lockedBalanceCNS, info.frozen, info.accountAddr);
    }

    function idleCollateral() external view returns (uint256) {
        return collateral.balanceOf(address(this));
    }
}
