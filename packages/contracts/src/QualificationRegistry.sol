// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAgentIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Evaluator attestations consumed by the vault, not permissionless proof of skill.
contract QualificationRegistry is Ownable2Step {
    error InvalidQualification();

    struct Qualification {
        address identityOwner;
        address operator;
        bytes32 suite;
        bytes32 evidence;
        uint64 expiresAt;
        bool passed;
    }
    IAgentIdentity public immutable identity;
    mapping(uint256 => Qualification) public qualifications;
    event QualificationRecorded(
        uint256 indexed agentId,
        address indexed operator,
        bytes32 indexed suite,
        bytes32 evidence,
        uint64 expiresAt,
        bool passed
    );

    constructor(IAgentIdentity identity_, address evaluator) Ownable(evaluator) {
        if (address(identity_).code.length == 0) revert InvalidQualification();
        identity = identity_;
    }

    function record(uint256 agentId, address operator, bytes32 suite, bytes32 evidence, uint64 expiresAt, bool passed)
        external
        onlyOwner
    {
        if (
            operator == address(0) || suite == bytes32(0) || evidence == bytes32(0)
                || (passed && expiresAt <= block.timestamp)
        ) revert InvalidQualification();
        address identityOwner = identity.ownerOf(agentId);
        if (identityOwner == address(0)) revert InvalidQualification();
        qualifications[agentId] = Qualification({
            identityOwner: identityOwner,
            operator: operator,
            suite: suite,
            evidence: evidence,
            expiresAt: expiresAt,
            passed: passed
        });
        emit QualificationRecorded(agentId, operator, suite, evidence, expiresAt, passed);
    }

    function isQualified(uint256 agentId, address operator, bytes32 suite) external view returns (bool) {
        Qualification memory q = qualifications[agentId];
        if (!q.passed || q.expiresAt <= block.timestamp || q.operator != operator || q.suite != suite) return false;
        try identity.ownerOf(agentId) returns (address currentOwner) {
            return currentOwner == q.identityOwner;
        } catch {
            return false;
        }
    }
}
