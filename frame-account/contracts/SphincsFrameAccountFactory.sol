// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SphincsFrameAccount} from "./SphincsFrameAccount.sol";

/// @notice Permissionless CREATE2 deployment of immutable SPHINCS frame accounts.
contract SphincsFrameAccountFactory {
    address public immutable SPHINCS_VERIFIER;
    address public immutable ACCOUNT_IMPL;
    bytes32 public constant VERIFIER_CODE_HASH =
        0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417;

    error UnsupportedVerifier();
    error InvalidPublicKeyEncoding();
    error DeploymentFailed();

    event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 pkSeed, bytes32 pkRoot);

    constructor(address verifier) {
        if (verifier.codehash != VERIFIER_CODE_HASH) revert UnsupportedVerifier();
        SPHINCS_VERIFIER = verifier;
        ACCOUNT_IMPL = address(new SphincsFrameAccount(verifier));
    }

    /// @dev The complete public key and verifier are bound through the init-code
    ///      hash. A third party can deploy the same account but cannot take it over.
    function createAccount(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) external returns (address account) {
        if (uint128(uint256(pkSeed)) != 0 || uint128(uint256(pkRoot)) != 0) {
            revert InvalidPublicKeyEncoding();
        }
        account = getAddress(pkSeed, pkRoot, salt);
        if (account.code.length != 0) return account;
        bytes memory initCode = _initCode(pkSeed, pkRoot);
        assembly ("memory-safe") { account := create2(0, add(initCode, 32), mload(initCode), salt) }
        if (account == address(0)) revert DeploymentFailed();
        emit AccountCreated(account, salt, pkSeed, pkRoot);
    }

    function getAddress(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(_initCode(pkSeed, pkRoot));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function accountRuntime(bytes32 pkSeed, bytes32 pkRoot) public view returns (bytes memory) {
        // Standard 45-byte EIP-1167 runtime followed by the immutable public key.
        return abi.encodePacked(hex"363d3d373d3d3d363d73", bytes20(ACCOUNT_IMPL),
            hex"5af43d82803e903d91602b57fd5bf3", pkSeed, pkRoot);
    }

    function _initCode(bytes32 pkSeed, bytes32 pkRoot) private view returns (bytes memory) {
        // Copy and return the 109-byte clone runtime from offset ten.
        return abi.encodePacked(hex"3d606d80600a3d3981f3", accountRuntime(pkSeed, pkRoot));
    }
}
