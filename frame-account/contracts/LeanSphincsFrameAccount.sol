// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LeanSphincsFrameRuntime} from "./LeanSphincsFrameRuntime.sol";

/// @notice Immutable leanSPHINCS-only account implementation for native Daisugi frame transactions.
/// @dev Construction returns the native implementation used through immutable EIP-1167 clones. The 32-byte
///      public key (PK.seed || PK.root) is in each clone's code. This is not ERC-4337. Experimental and not audited.
contract LeanSphincsFrameAccount {
    /// @dev Keccak-256 of the LeanSphincsVerifier runtime compiled as LeanSphincsVerifier.sol with Solidity 0.8.28,
    ///      via IR, optimizer 200 runs, Cancun. Any change to the verifier source changes this hash.
    bytes32 internal constant VERIFIER_CODE_HASH =
        0xcb1899cf8beccc7a966a04de3bdff0f24a4b32d6368fcfbb8c4d139b10b17aa9;

    error UnsupportedVerifier();

    constructor(address verifier) {
        if (verifier.codehash != VERIFIER_CODE_HASH) revert UnsupportedVerifier();
        bytes memory runtime = LeanSphincsFrameRuntime.build(verifier);
        assembly ("memory-safe") { return(add(runtime, 32), mload(runtime)) }
    }
}
