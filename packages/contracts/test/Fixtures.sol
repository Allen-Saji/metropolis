// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAgentIdentity} from "../src/QualificationRegistry.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function envOr(string calldata, string calldata) external returns (string memory);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
}

contract TestAsset is ERC20 {
    constructor() ERC20("Test AUSD", "AUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestIdentity is IAgentIdentity {
    mapping(uint256 => address) public ownerOf;

    function setOwner(uint256 id, address owner) external {
        ownerOf[id] = owner;
    }
}

// Controllable exchange double for adversarial state tests. Live ABI tests use a separate fork.
contract TestExchange is IPerplExchange {
    TestAsset public immutable asset;
    mapping(address => AccountInfo) private accounts;
    mapping(uint256 => address) private owners;
    mapping(uint256 => mapping(uint256 => PositionInfoV2)) private positions;
    uint256 private nextAccount = 1;
    bool public invalidMark;
    bool public staleMark;
    bool public leaveOrder;
    bool public withdrawalFails;
    bool public leaveOrderAfterExecution;
    uint256 public calls;

    constructor(TestAsset asset_) {
        asset = asset_;
    }

    function setLeaveOrderAfterExecution() external {
        leaveOrderAfterExecution = true;
    }

    function configure(bool invalid_, bool stale_, bool order_, bool fails_) external {
        invalidMark = invalid_;
        staleMark = stale_;
        leaveOrder = order_;
        withdrawalFails = fails_;
    }

    function createAccount(uint256 amount) external returns (uint256 id) {
        require(accounts[msg.sender].accountId == 0);
        id = nextAccount++;
        accounts[msg.sender].accountId = id;
        accounts[msg.sender].accountAddr = msg.sender;
        owners[id] = msg.sender;
        _deposit(amount);
    }

    function depositCollateral(uint256 amount) external {
        _deposit(amount);
    }

    function _deposit(uint256 amount) private {
        require(asset.transferFrom(msg.sender, address(this), amount));
        accounts[msg.sender].balanceCNS += amount;
    }

    function withdrawCollateral(uint256 amount) external {
        require(!withdrawalFails, "venue withdrawal unavailable");
        accounts[msg.sender].balanceCNS -= amount;
        require(asset.transfer(msg.sender, amount));
    }

    function getAccountByAddr(address who) external view returns (AccountInfo memory) {
        require(accounts[who].accountId != 0, "unknown account");
        return accounts[who];
    }

    function getOrderLocks(uint256) external view returns (OrderLock[] memory locks) {
        locks = new OrderLock[](leaveOrder ? 1 : 0);
    }

    function getPerpetualInfoV2(uint256 perpId) public view returns (PerpetualInfoV2 memory p) {
        require(perpId == 16 || perpId == 32);
        p.priceDecimals = 2;
        p.lotDecimals = 3;
        p.markPNS = 100_000; // 1000 AUSD per unit; each lot is 1 AUSD.
        p.markTimestamp = staleMark ? block.timestamp - 61 : block.timestamp;
    }

    function getPositionV2(uint256 perpId, uint256 id) external view returns (PositionInfoV2 memory, uint256, bool) {
        return (positions[id][perpId], 100_000, !invalidMark);
    }

    function execOrderV2(OrderDesc calldata o, bytes calldata extension) external returns (OrderSignature memory) {
        require(extension.length == 0);
        ++calls;
        if (leaveOrderAfterExecution) leaveOrder = true;
        AccountInfo storage a = accounts[msg.sender];
        require(a.accountId != 0);
        PositionInfoV2 storage p = positions[a.accountId][o.perpId];
        if (o.orderType < 2) {
            require(p.lotLNS == 0 || p.positionType == o.orderType);
            uint256 margin = o.lotLNS * 1e6 / 2;
            a.balanceCNS -= margin;
            p.accountId = a.accountId;
            p.positionType = o.orderType;
            p.depositCNS += margin;
            p.lotLNS += o.lotLNS;
            a.positions.bank1 |= uint256(1) << o.perpId;
        } else {
            require(o.orderType == p.positionType + 2 && p.lotLNS == o.lotLNS);
            int256 returned = int256(p.depositCNS) + p.pnlCNS;
            require(returned >= 0);
            a.balanceCNS += uint256(returned);
            delete positions[a.accountId][o.perpId];
            a.positions.bank1 &= ~(uint256(1) << o.perpId);
        }
        return OrderSignature(o.perpId, 0);
    }

    function setPnl(address who, uint256 perpId, int256 pnl) external {
        PositionInfoV2 storage p = positions[accounts[who].accountId][perpId];
        p.pnlCNS = pnl;
        p.deltaPnlCNS = pnl;
    }

    function setBalance(address who, uint256 amount) external {
        accounts[who].balanceCNS = amount;
    }

    function injectUnknownPosition(address who) external {
        accounts[who].positions.bank2 = 1;
    }
}
