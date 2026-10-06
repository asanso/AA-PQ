//! Experimental proof-bearing payload types. Not selected by the live fork schedule.
//!
//! Existing Electra containers are unchanged. This transport container must be
//! wired into an explicitly versioned consensus transition before node use.

use educe::Educe;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ssz::Decode;
use ssz_derive::{Decode, Encode};
use ssz_types::{VariableList, typenum::U8388608};
use tree_hash::TreeHash;
use tree_hash_derive::TreeHash;

use crate::{EthSpec, ExecutionPayloadElectra, ExecutionPayloadHeaderElectra, Hash256};

/// Matches the pinned Nethermind EIP-8288 proof bound. This is not a security level.
pub const MAX_RECURSIVE_PROOF_BYTES: usize = 8 * 1024 * 1024;

/// Transport validation only; cryptographic verification belongs to the EL.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Encode)]
#[ssz(struct_behaviour = "transparent")]
pub struct RecursiveProof(VariableList<u8, U8388608>);

#[cfg(feature = "arbitrary")]
impl<'a> arbitrary::Arbitrary<'a> for RecursiveProof {
    fn arbitrary(u: &mut arbitrary::Unstructured<'a>) -> arbitrary::Result<Self> {
        let bytes = <Vec<u8> as arbitrary::Arbitrary>::arbitrary(u)?;
        Self::try_from(bytes).map_err(|_| arbitrary::Error::IncorrectFormat)
    }
}

impl RecursiveProof {
    pub fn bytes(&self) -> &[u8] {
        self.0.as_ref()
    }
}

impl TreeHash for RecursiveProof {
    fn tree_hash_type() -> tree_hash::TreeHashType {
        VariableList::<u8, U8388608>::tree_hash_type()
    }
    fn tree_hash_packed_encoding(&self) -> tree_hash::PackedEncoding {
        self.0.tree_hash_packed_encoding()
    }
    fn tree_hash_packing_factor() -> usize {
        VariableList::<u8, U8388608>::tree_hash_packing_factor()
    }
    fn tree_hash_root(&self) -> tree_hash::Hash256 {
        self.0.tree_hash_root()
    }
}

impl TryFrom<Vec<u8>> for RecursiveProof {
    type Error = &'static str;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        if bytes.is_empty() {
            return Err("Recursive proof must not be empty");
        }
        VariableList::new(bytes)
            .map(Self)
            .map_err(|_| "Recursive proof exceeds 8 MiB")
    }
}

impl Decode for RecursiveProof {
    fn is_ssz_fixed_len() -> bool {
        false
    }
    fn from_ssz_bytes(bytes: &[u8]) -> Result<Self, ssz::DecodeError> {
        if bytes.is_empty() {
            return Err(ssz::DecodeError::BytesInvalid(
                "Recursive proof must not be empty".into(),
            ));
        }
        VariableList::from_ssz_bytes(bytes).map(Self)
    }
}

impl Serialize for RecursiveProof {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ssz_types::serde_utils::hex_var_list::serialize(&self.0, serializer)
    }
}

impl<'de> Deserialize<'de> for RecursiveProof {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bytes: VariableList<u8, U8388608> =
            ssz_types::serde_utils::hex_var_list::deserialize(deserializer)?;
        if bytes.is_empty() {
            return Err(serde::de::Error::custom(
                "Recursive proof must not be empty",
            ));
        }
        Ok(Self(bytes))
    }
}

/// Candidate SSZ container: unchanged Electra payload, complete proof, commitment.
#[derive(Debug, Clone, Serialize, Deserialize, Encode, Decode, TreeHash, Educe)]
#[educe(PartialEq, Hash(bound(E: EthSpec)))]
#[serde(bound = "E: EthSpec", deny_unknown_fields)]
pub struct AggregateExecutionPayload<E: EthSpec> {
    pub payload: ExecutionPayloadElectra<E>,
    pub recursive_stark_proof: RecursiveProof,
    pub recursive_stark_block_deps_hash: Hash256,
}

/// Blinding preserves the full container's root; it does not provide proof bytes.
#[derive(Debug, Clone, Serialize, Deserialize, Encode, Decode, TreeHash, Educe)]
#[educe(PartialEq, Hash(bound(E: EthSpec)))]
#[serde(bound = "E: EthSpec", deny_unknown_fields)]
pub struct AggregateExecutionPayloadHeader<E: EthSpec> {
    pub payload: ExecutionPayloadHeaderElectra<E>,
    pub recursive_stark_proof_root: Hash256,
    pub recursive_stark_block_deps_hash: Hash256,
}

impl<E: EthSpec> AggregateExecutionPayload<E> {
    pub fn to_header(&self) -> AggregateExecutionPayloadHeader<E> {
        AggregateExecutionPayloadHeader {
            payload: ExecutionPayloadHeaderElectra::from(&self.payload),
            recursive_stark_proof_root: self.recursive_stark_proof.tree_hash_root(),
            recursive_stark_block_deps_hash: self.recursive_stark_block_deps_hash,
        }
    }
}

impl<E: EthSpec> AggregateExecutionPayloadHeader<E> {
    /// A header alone is insufficient; unblinding must match every committed field.
    pub fn accepts(&self, payload: &AggregateExecutionPayload<E>) -> bool {
        self.tree_hash_root() == payload.tree_hash_root()
    }
}

// A default payload contains no dependency claims. Missing transport data is still rejected.
impl Default for RecursiveProof {
    fn default() -> Self {
        Self::try_from(b"NLR3\0\0\0\0\0\0\0\0".to_vec()).expect("Canonical empty-set envelope")
    }
}
