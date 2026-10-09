//! Engine JSON adapter for the experimental proof-bearing consensus container.
//! This module is not connected to the live Engine request-selection path.

use serde::{Deserialize, Serialize};
use types::{AggregateExecutionPayload, EthSpec, Hash256, RecursiveProof};
use super::json_structures::JsonExecutionPayloadElectra;

/// Preserve the pinned Nethermind field names alongside the existing Engine fields.
/// Both fields are required; no cache lookup or proof substitution is performed.
#[derive(Debug, Serialize, Deserialize)]
#[serde(bound = "E: EthSpec", rename_all = "camelCase")]
pub struct JsonAggregateExecutionPayload<E: EthSpec> {
    #[serde(flatten)]
    pub payload: JsonExecutionPayloadElectra<E>,
    pub recursive_stark_proof: RecursiveProof,
    pub recursive_stark_block_deps_hash: Hash256,
}

impl<E: EthSpec> TryFrom<JsonAggregateExecutionPayload<E>> for AggregateExecutionPayload<E> {
    type Error = ssz_types::Error;
    fn try_from(value: JsonAggregateExecutionPayload<E>) -> Result<Self, Self::Error> {
        Ok(Self {
            payload: value.payload.try_into()?,
            recursive_stark_proof: value.recursive_stark_proof,
            recursive_stark_block_deps_hash: value.recursive_stark_block_deps_hash,
        })
    }
}

impl<E: EthSpec> TryFrom<AggregateExecutionPayload<E>> for JsonAggregateExecutionPayload<E> {
    type Error = ssz_types::Error;
    fn try_from(value: AggregateExecutionPayload<E>) -> Result<Self, Self::Error> {
        Ok(Self {
            payload: value.payload.try_into()?,
            recursive_stark_proof: value.recursive_stark_proof,
            recursive_stark_block_deps_hash: value.recursive_stark_block_deps_hash,
        })
    }
}
