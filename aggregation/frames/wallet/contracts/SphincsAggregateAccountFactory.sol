// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregateAccountRuntime} from "./AggregateAccountRuntime.sol";

/// @notice Experimental immutable accounts for the pinned native aggregation fork.
contract SphincsAggregateAccountFactory {
    address public immutable ACCOUNT_IMPL;
    error InvalidPublicKeyEncoding();
    error DeploymentFailed();
    error UnexpectedAccountCode();
    event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 keyHash);

    constructor() {
        bytes memory runtime = AggregateAccountRuntime.build();
        bytes memory creation = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600a5f395ff3", runtime);
        address implementation;
        assembly ("memory-safe") { implementation := create(0, add(creation, 32), mload(creation)) }
        if (implementation == address(0)) revert DeploymentFailed();
        ACCOUNT_IMPL = implementation;
    }

    function publicKeyHash(bytes32 pkSeed, bytes32 pkRoot) public pure returns (bytes32) {
        if (uint128(uint256(pkSeed)) != 0 || uint128(uint256(pkRoot)) != 0) revert InvalidPublicKeyEncoding();
        return keccak256(abi.encodePacked(bytes16(pkRoot), bytes16(pkSeed)));
    }

    function accountRuntime(bytes32 pkSeed, bytes32 pkRoot) public view returns (bytes memory) {
        return abi.encodePacked(hex"363d3d373d3d3d363d73", bytes20(ACCOUNT_IMPL),
            hex"5af43d82803e903d91602b57fd5bf3", publicKeyHash(pkSeed, pkRoot));
    }

    function initCode(bytes32 pkSeed, bytes32 pkRoot) public view returns (bytes memory) {
        return abi.encodePacked(hex"3d604d80600a3d3981f3", accountRuntime(pkSeed, pkRoot));
    }

    function getAddress(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt,
            keccak256(initCode(pkSeed, pkRoot)))))));
    }

    function createAccount(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) external returns (address account) {
        account = getAddress(pkSeed, pkRoot, salt);
        if (account.code.length != 0) {
            if (account.codehash != keccak256(accountRuntime(pkSeed, pkRoot))) revert UnexpectedAccountCode();
            return account;
        }
        bytes memory creation = initCode(pkSeed, pkRoot);
        assembly ("memory-safe") { account := create2(0, add(creation, 32), mload(creation), salt) }
        if (account == address(0)) revert DeploymentFailed();
        emit AccountCreated(account, salt, publicKeyHash(pkSeed, pkRoot));
    }
}
