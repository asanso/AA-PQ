// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LeanSphincsFrameAccount} from "./LeanSphincsFrameAccount.sol";

/// @notice Permissionless CREATE2 deployment of immutable leanSPHINCS frame accounts. Experimental and not audited.
contract LeanSphincsFrameAccountFactory {
    address public immutable LEAN_SPHINCS_VERIFIER;
    address public immutable ACCOUNT_IMPL;
    /// @dev The same pinned verifier runtime hash as LeanSphincsFrameAccount.
    bytes32 public constant VERIFIER_CODE_HASH =
        0xcb1899cf8beccc7a966a04de3bdff0f24a4b32d6368fcfbb8c4d139b10b17aa9;

    error UnsupportedVerifier();
    error DeploymentFailed();

    event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 publicKey);

    constructor(address verifier) {
        if (verifier.codehash != VERIFIER_CODE_HASH) revert UnsupportedVerifier();
        LEAN_SPHINCS_VERIFIER = verifier;
        ACCOUNT_IMPL = address(new LeanSphincsFrameAccount(verifier));
    }

    /// @dev The public key (PK.seed || PK.root) and the verifier are bound through the init-code hash. A third party
    ///      can deploy the same account but cannot take it over.
    function createAccount(bytes32 publicKey, bytes32 salt) external returns (address account) {
        account = getAddress(publicKey, salt);
        if (account.code.length != 0) return account;
        bytes memory initCode = _initCode(publicKey);
        assembly ("memory-safe") { account := create2(0, add(initCode, 32), mload(initCode), salt) }
        if (account == address(0)) revert DeploymentFailed();
        emit AccountCreated(account, salt, publicKey);
    }

    function getAddress(bytes32 publicKey, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(_initCode(publicKey));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function accountRuntime(bytes32 publicKey) public view returns (bytes memory) {
        // Standard 45-byte EIP-1167 runtime followed by the immutable 32-byte public key.
        return abi.encodePacked(hex"363d3d373d3d3d363d73", bytes20(ACCOUNT_IMPL),
            hex"5af43d82803e903d91602b57fd5bf3", publicKey);
    }

    function _initCode(bytes32 publicKey) private view returns (bytes memory) {
        // Copy and return the 77-byte clone runtime from offset ten.
        return abi.encodePacked(hex"3d604d80600a3d3981f3", accountRuntime(publicKey));
    }
}
