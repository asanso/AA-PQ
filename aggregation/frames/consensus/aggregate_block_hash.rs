//! Experimental Prague-based block-hash reconstruction for the pinned EL encoding.
//! Existing block hashing is unchanged; fork dispatch must select this explicitly.

use alloy_rlp::{Encodable, Header};
use crate::{block_hash::{rlp_encode_block_header, rlp_encode_withdrawal}, keccak::{KeccakHasher, keccak256}};
use types::{AggregateExecutionPayload, EthSpec, ExecutionBlockHash, ExecutionBlockHeader,
    ExecutionPayloadRef, ExecutionRequests, Hash256};
use triehash::ordered_trie_root;
use keccak_hash::KECCAK_EMPTY_LIST_RLP;
use crate::json_structures::JsonWithdrawal;

pub fn aggregate_execution_block_hash<E: EthSpec>(
    payload: &AggregateExecutionPayload<E>,
    parent_beacon_block_root: Hash256,
    execution_requests: &ExecutionRequests<E>,
) -> Result<ExecutionBlockHash, alloy_rlp::Error> {
    let base = ExecutionPayloadRef::Electra(&payload.payload);
    let (_, tx_root) = crate::calculate_execution_block_hash(base, Some(parent_beacon_block_root), Some(execution_requests));
    let withdrawal_root = ordered_trie_root::<KeccakHasher, _>(payload.payload.withdrawals.iter()
        .map(|w| rlp_encode_withdrawal(&JsonWithdrawal::from(w.clone()))));
    let header = ExecutionBlockHeader::from_payload(base, KECCAK_EMPTY_LIST_RLP.as_fixed_bytes().into(),
        tx_root, Some(withdrawal_root), Some(payload.payload.blob_gas_used), Some(payload.payload.excess_blob_gas),
        Some(parent_beacon_block_root), Some(execution_requests.requests_hash()));
    let legacy = rlp_encode_block_header(&header);
    let mut content = legacy.as_slice();
    let prefix = Header::decode(&mut content)?;
    if !prefix.list || prefix.payload_length != content.len() { return Err(alloy_rlp::Error::Custom("Invalid base header")); }
    let mut fields = content.to_vec();
    // The pinned Nethermind codec pads optional pre-proof fields: no BAL, slot zero.
    fields.extend_from_slice(&[0x80, 0x80]);
    let proof = payload.recursive_stark_proof.bytes();
    let commitment = payload.recursive_stark_block_deps_hash.as_slice();
    Header { list: true, payload_length: proof.length() + commitment.length() }.encode(&mut fields);
    proof.encode(&mut fields);
    commitment.encode(&mut fields);
    let mut output = Vec::new();
    Header { list: true, payload_length: fields.len() }.encode(&mut output);
    output.extend_from_slice(&fields);
    Ok(ExecutionBlockHash::from_root(keccak256(&output)))
}
