// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LeanSphincsVerifierReference
/// @notice The readable leanSPHINCS verifier: a direct mapping of the specification, kept to document the
///         computation and as a test oracle for the generated, gas-optimised LeanSphincsVerifier. Not deployed.
///         Verifies leanSPHINCS signatures: the stateless hash-based scheme of leanEthereum/leanVM
///         `crates/lean_sphincs` at f7ba4999ae523b94c8d0969b32762c3effea4cbd, the revision Nethermind pins for
///         EIP-8288 scheme 0x10 on Daisugi devnet-1. EthLib specifies the same scheme in Lean.
/// @dev    Experimental and not audited. Do not use with real funds.
///
///         Parameters: Keccak-256 truncated to n = 16 bytes; a hypertree of d = 3 layers of heights 8, 8 and 10
///         (h = 26, bottom first) of WOTS+C keys with w = 2, v = 64 chains and target sum 128; FORS with k = 24 trees
///         of height 10. A key signs at most 2^30 messages (127-bit SUF security in the ROM, per the upstream crate).
///
///         Encodings, exactly as upstream:
///         - public key, 32 bytes: PK.seed (16) || PK.root (16);
///         - message, 32 bytes;
///         - signature, 7,740 bytes: R (16), then 24 FORS openings of a secret (16) and a 10-node path (160), then
///           for each layer bottom first a big-endian counter (4), 64 chain values (1,024) and its path (16 per level).
///
///         Every tweakable hash is Trunc_16(keccak256(PK.seed || ADRS || M)) with FIPS 205's 32-byte address of eight
///         big-endian words: layer, three tree words (the first always zero here), type, key pair, chain or height,
///         hash or index. Inside the assembly a 16-byte value is held in the high half of a 32-byte word.
///
///         Memory layout, all past the free memory pointer and used only for the duration of the call:
///         - hashBuf + 0x00: PK.seed | ADRS | up to 48 payload bytes, for F, H and the WOTS+C encoding;
///         - listBuf = hashBuf + 0x80: PK.seed | ADRS | up to 64 values, for the WOTS+C leaf and the FORS key;
///         - msgBuf  = hashBuf + 0x500: R | PK.seed | PK.root | M | BE32(i), for H_msg.
contract LeanSphincsVerifierReference {
    /// @notice The only accepted signature length.
    uint256 public constant SIGNATURE_LENGTH = 7740;

    /// @notice A signature of any other length is rejected, as EthLib rejects it, rather than reported invalid.
    error InvalidSignatureLength(uint256 length);

    /// @notice Whether `signature` is a leanSPHINCS signature of `message` under `publicKey`.
    /// @param publicKey PK.seed || PK.root.
    /// @param message The 32-byte message, for a frame account the EIP-8141 signature hash.
    /// @param signature The 7,740-byte signature.
    /// @return valid True if and only if the signature verifies.
    function verify(bytes32 publicKey, bytes32 message, bytes calldata signature) external pure returns (bool valid) {
        if (signature.length != SIGNATURE_LENGTH) revert InvalidSignatureLength(signature.length);
        assembly ("memory-safe") {
            // Mask keeping the high 16 bytes of a word: an n-byte value, or a truncated Keccak-256 output.
            function high() -> mask {
                mask := not(0xffffffffffffffffffffffffffffffff)
            }

            // FIPS 205 address (§4.2): eight big-endian 32-bit words. The tree address fits in its low 64 bits.
            function adrs(layer, tree, addressType, keyPair, word2, word3) -> a {
                a := or(
                    or(shl(224, layer), shl(128, tree)),
                    or(or(shl(96, addressType), shl(64, keyPair)), or(shl(32, word2), word3))
                )
            }

            // F: Trunc_n(keccak256(PK.seed | ADRS | value)), one 16-byte value.
            function thOne(buf, a, value) -> out {
                mstore(add(buf, 0x10), a)
                mstore(add(buf, 0x30), value)
                out := and(keccak256(buf, 0x40), high())
            }

            // H: Trunc_n(keccak256(PK.seed | ADRS | left | right)), a node from its two children.
            function thTwo(buf, a, left, right) -> out {
                mstore(add(buf, 0x10), a)
                mstore(add(buf, 0x30), left)
                mstore(add(buf, 0x40), right)
                out := and(keccak256(buf, 0x50), high())
            }

            // The 16-byte value at calldata offset `ptr`.
            function value16(ptr) -> v {
                v := and(calldataload(ptr), high())
            }

            // Tree.fold: the root that `node`, leaf `leafIndex` of tree `tree` on hypertree layer `layer`, reaches
            // through the `height` siblings at `pathPtr`. Node j at height z has address (layer, tree, TREE, 0, z, j).
            function treeFold(buf, layer, tree, leafIndex, node, pathPtr, height) -> root {
                let base := adrs(layer, tree, 2, 0, 0, 0)
                for { let z := 0 } lt(z, height) { z := add(z, 1) } {
                    let sibling := value16(add(pathPtr, shl(4, z)))
                    let a := or(base, or(shl(32, add(z, 1)), shr(add(z, 1), leafIndex)))
                    switch and(shr(z, leafIndex), 1)
                    case 0 { node := thTwo(buf, a, node, sibling) }
                    default { node := thTwo(buf, a, sibling, node) }
                }
                root := node
            }

            // One FORS tree's root from its opening at `opening`: the secret of leaf `s` of tree `c`, then its path.
            // Node j at height z of tree c has address (0, tree, FORS_TREE, keyPair, z, (c << (10 - z)) + j), the
            // tree and key pair being those of the bottom one-time key the instance belongs to (`forsBase`).
            function forsRoot(buf, forsBase, c, s, opening) -> root {
                root := thOne(buf, or(forsBase, add(shl(10, c), s)), value16(opening))
                for { let z := 0 } lt(z, 10) { z := add(z, 1) } {
                    let sibling := value16(add(opening, shl(4, add(z, 1))))
                    let h := add(z, 1)
                    let a := or(forsBase, or(shl(32, h), add(shl(sub(10, h), c), shr(h, s))))
                    switch and(shr(z, s), 1)
                    case 0 { root := thTwo(buf, a, root, sibling) }
                    default { root := thTwo(buf, a, sibling, root) }
                }
            }

            // Wots.leaf: the one-time key (layer, tree, leaf) has signed `signed` with the counter and the 64 chain
            // values at `layerPtr`. Returns the leaf the chains recover, and whether the counter is admissible: the
            // encoding Trunc_n(keccak256(PK.seed | ADRS_enc | signed | BE32(counter))), read as 64 two-bit digits
            // most significant first, must sum to 128. Chain i then runs from its digit to 3, the step leaving
            // position `step` hashed at address (layer, tree, WOTS_HASH, leaf, i, step).
            function wotsLeaf(buf, listBuf, layer, tree, leaf, signed, layerPtr) -> leafValue, admissible {
                mstore(add(buf, 0x10), adrs(layer, tree, 7, leaf, 0, 0))
                mstore(add(buf, 0x30), signed)
                mstore(add(buf, 0x40), and(calldataload(layerPtr), shl(224, 0xffffffff)))
                let digits := shr(128, keccak256(buf, 0x44))

                let sum := 0
                let chainBase := adrs(layer, tree, 0, leaf, 0, 0)
                let values := add(layerPtr, 4)
                for { let i := 0 } lt(i, 64) { i := add(i, 1) } {
                    let digit := and(shr(shl(1, sub(63, i)), digits), 3)
                    sum := add(sum, digit)
                    let v := value16(add(values, shl(4, i)))
                    for { let step := digit } lt(step, 3) { step := add(step, 1) } {
                        v := thOne(buf, or(chainBase, or(shl(32, i), step)), v)
                    }
                    mstore(add(listBuf, add(0x30, shl(4, i))), v)
                }
                admissible := eq(sum, 128)

                // T_v over the 64 chain ends, at address (layer, tree, WOTS_PK, leaf, 0, 0).
                mstore(add(listBuf, 0x10), adrs(layer, tree, 1, leaf, 0, 0))
                leafValue := and(keccak256(listBuf, 0x430), high())
            }

            // H_msg: keccak256(R | PK.seed | PK.root | M | BE32(i)) for i = 0, 1, at `msgBuf`. Of the 34 digest bytes,
            // the first 30 hold the 24 ten-bit FORS leaves, all inside call 0 (`h0`); bytes 30..33 hold the 18-bit tree
            // index and byte 33 the 8-bit bottom leaf. The index is tree << 8 | leaf.
            function messageDigest(msgBuf, randomizer, pkSeed, pkRoot, m) -> h0, idx {
                mstore(msgBuf, randomizer)
                mstore(add(msgBuf, 0x10), pkSeed)
                mstore(add(msgBuf, 0x20), pkRoot)
                mstore(add(msgBuf, 0x30), m)
                mstore(add(msgBuf, 0x50), 0)
                h0 := keccak256(msgBuf, 0x54)
                mstore(add(msgBuf, 0x50), shl(224, 1))
                let h1 := keccak256(msgBuf, 0x54)
                let tree := and(or(shl(8, and(h0, 0xffff)), shr(248, h1)), 0x3ffff)
                idx := or(shl(8, tree), and(shr(240, h1), 0xff))
            }

            // fors_pkFromSig: the 24 roots, then T_k over them at address (0, idx >> 8, FORS_ROOTS, idx & 0xff, 0, 0).
            // Tree c's leaf is bits 10c..10c+9 of the digest, most significant first.
            function forsKey(buf, listBuf, sig, h0, idx) -> key {
                let forsBase := adrs(0, shr(8, idx), 3, and(idx, 0xff), 0, 0)
                for { let c := 0 } lt(c, 24) { c := add(c, 1) } {
                    let s := and(shr(sub(246, mul(10, c)), h0), 0x3ff)
                    mstore(add(listBuf, add(0x30, shl(4, c))), forsRoot(buf, forsBase, c, s, add(sig, add(16, mul(c, 176)))))
                }
                mstore(add(listBuf, 0x10), adrs(0, shr(8, idx), 4, and(idx, 0xff), 0, 0))
                key := and(keccak256(listBuf, 0x1b0), high())
            }

            // The hypertree, bottom first: each layer's key signs what the layer below gives, and its tree's root
            // goes up. The layer of height `height` starts at bit `shift` of the index; its signature at `layerPtr`
            // holds the counter (4), the chain values (1,024) and the path (16 per level).
            function hypertreeRoot(buf, listBuf, sig, idx, signed) -> root, admissible {
                let layerPtr := add(sig, 4240)
                let shift := 0
                for { let layer := 0 } lt(layer, 3) { layer := add(layer, 1) } {
                    let height := 8
                    if eq(layer, 2) { height := 10 }
                    let e := shr(shift, idx)
                    let leaf := and(e, sub(shl(height, 1), 1))
                    let leafValue, ok := wotsLeaf(buf, listBuf, layer, shr(height, e), leaf, signed, layerPtr)
                    if iszero(ok) { leave }
                    signed := treeFold(buf, layer, shr(height, e), leaf, leafValue, add(layerPtr, 1028), height)
                    layerPtr := add(layerPtr, add(1028, shl(4, height)))
                    shift := add(shift, height)
                }
                root := signed
                admissible := 1
            }

            let hashBuf := mload(0x40)
            let pkSeed := and(publicKey, high())
            mstore(hashBuf, pkSeed)
            mstore(add(hashBuf, 0x80), pkSeed)

            let h0, idx := messageDigest(add(hashBuf, 0x500), value16(signature.offset), pkSeed, shl(128, publicKey), message)
            let signed := forsKey(hashBuf, add(hashBuf, 0x80), signature.offset, h0, idx)
            let root, admissible := hypertreeRoot(hashBuf, add(hashBuf, 0x80), signature.offset, idx, signed)
            valid := and(admissible, eq(root, shl(128, publicKey)))
        }
    }
}
