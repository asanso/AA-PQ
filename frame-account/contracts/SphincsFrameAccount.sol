// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SphincsFrameRuntime} from "./SphincsFrameRuntime.sol";

/// @notice Immutable SPHINCS-only account for the pinned Daisugi frame prototype.
/// @dev Construction returns the native implementation used through immutable
///      EIP-1167 clones. The key is in each clone's code. This is not ERC-4337.
contract SphincsFrameAccount {
    bytes32 internal constant VERIFIER_CODE_HASH =
        0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417;

    error UnsupportedVerifier();
    constructor(address verifier) {
        if (verifier.codehash != VERIFIER_CODE_HASH) revert UnsupportedVerifier();
        bytes memory runtime = SphincsFrameRuntime.build(verifier);
        assembly ("memory-safe") { return(add(runtime, 32), mload(runtime)) }
    }
}
