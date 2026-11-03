//! EIP-8288 block proof carried by Daisugi execution payloads.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ssz::Decode;
use ssz_derive::Encode;
use ssz_types::{VariableList, typenum::U8388608};
use tree_hash::TreeHash;

/// Transport bound only; the EL enforces the tighter EIP-8288 proof limit.
pub const MAX_RECURSIVE_PROOF_BYTES: usize = 8 * 1024 * 1024;

/// The EL derives the header commitment from these bytes, so the CL only carries them.
/// A block without dependencies carries an empty proof.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Encode)]
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
        ssz_types::serde_utils::hex_var_list::deserialize(deserializer).map(Self)
    }
}
