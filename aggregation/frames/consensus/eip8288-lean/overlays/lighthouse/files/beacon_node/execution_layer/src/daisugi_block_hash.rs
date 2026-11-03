//! EIP-8288 header commitment of a Daisugi payload, derived the way the Nethermind prototype derives
//! it (`FrameDependency.ForBlock` and `ComputeDepsHash`), so the block hash can be checked locally.

use crate::keccak::keccak256;
use alloy_rlp::{Decodable, Encodable, Header};
use blake2::{Blake2s256, Digest};
use types::Hash256;

const FRAME_TX_TYPE: u8 = 0x06;
const DEP_VERIFY_MODE: u64 = 4;
const DEPENDENCY_LENGTH: usize = 96;
const LEAN_SPHINCS_SCHEME: u8 = 0x10;
const LEAN_STARK_DEPS_DOMAIN: &[u8; 32] = b"eip8288/leanstark-deps\0\0\0\0\0\0\0\0\0\0";

type Dependency = (u8, [u8; 32], [u8; 32]);

/// Appends the commitment that follows the Prague fields of a Daisugi header: empty block access list
/// hash and zero slot placeholders, then `keccak(stark_proof)` and the block dependency hash.
pub fn append_commitment(fields: &mut Vec<u8>, stark_proof: &[u8], deps_hash: Hash256) {
    fields.extend_from_slice(&[0x80, 0x80]);
    keccak256(stark_proof).as_slice().encode(fields);
    deps_hash.as_slice().encode(fields);
}

/// `get_deps_hash(dependencies(block))` over the payload's encoded transactions.
pub fn block_deps_hash<'a>(
    transactions: impl IntoIterator<Item = &'a [u8]>,
) -> Result<Hash256, alloy_rlp::Error> {
    let mut dependencies: Vec<Dependency> = Vec::new();
    for tx in transactions {
        let Some((&FRAME_TX_TYPE, body)) = tx.split_first() else {
            continue;
        };
        let fields = list_items(body)?;
        // [chain_id, nonce_keys?, nonce, sender, frames, signatures, fees, blob_hashes]
        let Some(frames_index) = fields.len().checked_sub(4) else {
            return Err(alloy_rlp::Error::Custom(
                "frame transaction has too few fields",
            ));
        };
        let mut signature_hash: Option<[u8; 32]> = None;
        for frame in list_items(fields[frames_index])? {
            // [mode, flags, target, [execution_gas, state_gas], value, data]
            let frame = list_items(frame)?;
            if frame.len() != 6 || u64::decode(&mut &frame[0][..])? != DEP_VERIFY_MODE {
                continue;
            }
            let data = string_payload(frame[5])?;
            for triple in data.chunks_exact(DEPENDENCY_LENGTH) {
                let mut data_hash: [u8; 32] = triple[32..64].try_into().expect("32-byte slice");
                if data_hash == [0; 32] {
                    data_hash = match signature_hash {
                        Some(hash) => hash,
                        None => *signature_hash.insert(frame_signature_hash(body, &fields)?),
                    };
                }
                let key: [u8; 32] = triple[64..96].try_into().expect("32-byte slice");
                dependencies.push((triple[31], data_hash, key));
            }
        }
    }
    dependencies.sort_unstable();
    dependencies.dedup();
    Ok(deps_hash(&dependencies))
}

fn deps_hash(dependencies: &[Dependency]) -> Hash256 {
    let split = dependencies
        .iter()
        .take_while(|(scheme, _, _)| *scheme == LEAN_SPHINCS_SCHEME)
        .count();
    let sphincs = list_deps_hash(&dependencies[..split]);
    if split == dependencies.len() {
        return Hash256::from(sphincs);
    }
    let stark = list_deps_hash(&dependencies[split..]);
    let mut hasher = Blake2s256::new();
    hasher.update(sphincs);
    hasher.update(stark);
    hasher.update(LEAN_STARK_DEPS_DOMAIN);
    Hash256::from(<[u8; 32]>::from(hasher.finalize()))
}

fn list_deps_hash(dependencies: &[Dependency]) -> [u8; 32] {
    let mut hasher = Blake2s256::new();
    for (_, data_hash, key) in dependencies {
        hasher.update(data_hash);
        hasher.update(key);
    }
    hasher.finalize().into()
}

/// EIP-8141 canonical signature hash: `keccak(0x06 || rlp(tx))` with the signature bytes of every
/// empty-`msg` signature entry replaced by empty bytes.
fn frame_signature_hash(body: &[u8], fields: &[&[u8]]) -> Result<[u8; 32], alloy_rlp::Error> {
    let signatures_index = fields.len() - 3;
    let mut signatures = Vec::new();
    for entry in list_items(fields[signatures_index])? {
        // [scheme, signer, msg, signature]
        let parts = list_items(entry)?;
        if parts.len() != 4 {
            return Err(alloy_rlp::Error::Custom(
                "frame signature must have four fields",
            ));
        }
        if string_payload(parts[2])?.is_empty() {
            let mut content = parts[..3].concat();
            content.push(0x80);
            encode_list(&content, &mut signatures);
        } else {
            signatures.extend_from_slice(entry);
        }
    }

    let mut content = Vec::with_capacity(body.len());
    for (i, field) in fields.iter().enumerate() {
        if i == signatures_index {
            encode_list(&signatures, &mut content);
        } else {
            content.extend_from_slice(field);
        }
    }
    let mut preimage = vec![FRAME_TX_TYPE];
    encode_list(&content, &mut preimage);
    Ok(keccak256(&preimage).0)
}

fn encode_list(content: &[u8], out: &mut Vec<u8>) {
    Header {
        list: true,
        payload_length: content.len(),
    }
    .encode(out);
    out.extend_from_slice(content);
}

/// The encoded items of an RLP list, each with its own header.
fn list_items(encoded: &[u8]) -> Result<Vec<&[u8]>, alloy_rlp::Error> {
    let mut rest = encoded;
    let header = Header::decode(&mut rest)?;
    if !header.list || header.payload_length != rest.len() {
        return Err(alloy_rlp::Error::UnexpectedString);
    }
    let mut items = Vec::new();
    while !rest.is_empty() {
        let mut cursor = rest;
        let item = Header::decode(&mut cursor)?;
        let length = rest.len() - cursor.len() + item.payload_length;
        if length > rest.len() {
            return Err(alloy_rlp::Error::InputTooShort);
        }
        let (head, tail) = rest.split_at(length);
        items.push(head);
        rest = tail;
    }
    Ok(items)
}

fn string_payload(encoded: &[u8]) -> Result<&[u8], alloy_rlp::Error> {
    let mut rest = encoded;
    let header = Header::decode(&mut rest)?;
    if header.list || header.payload_length != rest.len() {
        return Err(alloy_rlp::Error::UnexpectedList);
    }
    Ok(rest)
}

/// Vectors emitted by the Nethermind `feature/eip8288-lean` prototype for a Prague-based header with an
/// EIP-8288 commitment. Source: `Eip8288CrossClientVectorTests` (Nethermind.Blockchain.Test), which
/// asserts the same values and writes them to `tools/daisugi-devnet/vectors/eip8288-block-hash.json`
/// on the Nethermind branch `test/daisugi-devnet`, based on `feature/eip8288-lean` at `c34b09d229`.
#[cfg(test)]
mod test {
    use super::*;
    use crate::Error;
    use crate::calculate_execution_block_hash;
    use crate::engine_api::{NewPayloadRequest, NewPayloadRequestDaisugi};
    use std::str::FromStr;
    use types::{
        Address, ExecutionBlockHash, ExecutionPayloadDaisugi, ExecutionPayloadRef,
        ExecutionRequests, MainnetEthSpec,
    };

    // A frame transaction whose DEP_VERIFY frame declares a zero-data-hash dependency (resolved to the
    // signature hash, eliding the empty-msg entry's signature but not the explicit-msg one) and a
    // duplicate; a frame transaction with a leanSTARK dependency; an EIP-1559 transaction.
    const TRANSACTIONS: [&str; 3] = [
        "06f90186820539c1800394b7705ae4c6f81b66cdb323c65f4e8133690fc099f9013ef9012c048080c4820bb88080b9012000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000fb447eee02953c223589c6fcf36eea0b02688593efecd35a0862f4bc47519a0800000000000000000000000000000000000000000000000000000000000000108d16a8ccf17118610ef3326d9f687991e2ed39ae1cad8b2978c2cf04965179f22bb19f419a00b83d96d60ba1f05b40409227fa1a7025f7cd2da260ca5d88760400000000000000000000000000000000000000000000000000000000000000108d16a8ccf17118610ef3326d9f687991e2ed39ae1cad8b2978c2cf04965179f22bb19f419a00b83d96d60ba1f05b40409227fa1a7025f7cd2da260ca5d887604ce010380c5830186a0808083010203e4c88080808409090909da0194942921b14f1b1c385cd7e0cc2ef7abe5598c835807820505c3010a80c0",
        "06f890820539c180809476e68a8696537e4141926f3e528733af9e237d69f86df86b048080c48275308080b8600000000000000000000000000000000000000000000000000000000000000011843b123350af3b9ab648aaf94c99e96eaac7c772f7a62ed71638fc18cc411cdcfb447eee02953c223589c6fcf36eea0b02688593efecd35a0862f4bc47519a08c0c3010a80c0",
        "02f86482053980010a8252089400000000000000000000000000000000000000000180c080a084727d6d5f5c900e2fc0502f5c96ee6487c95d9683db732c85fce6d69d37c680a058c7cb9faeb4031aab1cf3b3a99d84541a78ece6011d87de03ef1e5f33c24a4b",
    ];

    fn hash(value: &str) -> Hash256 {
        Hash256::from_str(value).unwrap()
    }

    fn transactions() -> Vec<Vec<u8>> {
        TRANSACTIONS
            .iter()
            .map(|tx| hex::decode(tx).unwrap())
            .collect()
    }

    #[test]
    fn dependency_hash_matches_nethermind() {
        let txs = transactions();
        assert_eq!(
            block_deps_hash(txs.iter().map(Vec::as_slice)).unwrap(),
            hash("0x0c145f044c75d7518b87b477dd563dc7449e80a07198ea769298075118458a60")
        );
        assert_eq!(
            block_deps_hash(std::iter::empty()).unwrap(),
            hash("0x69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9")
        );
    }

    #[test]
    fn signature_hash_matches_nethermind() {
        let tx = &transactions()[0];
        let body = &tx[1..];
        let fields = list_items(body).unwrap();
        assert_eq!(
            Hash256::from(frame_signature_hash(body, &fields).unwrap()),
            hash("0xe66fa6dfbd6d3b05d2b8331a13c8e8f3a8824e7e8ee88102214dd39004f5be53")
        );
    }

    #[test]
    fn undecodable_frame_transaction_is_rejected() {
        let mut tx = transactions()[0].clone();
        tx.truncate(tx.len() - 1);
        assert!(block_deps_hash([tx.as_slice()]).is_err());

        // The zero hash the payload hashes to must not verify a payload that claims it.
        let payload = ExecutionPayloadDaisugi::<MainnetEthSpec> {
            transactions: vec![tx.try_into().unwrap()].try_into().unwrap(),
            block_hash: ExecutionBlockHash::zero(),
            ..Default::default()
        };
        let execution_requests = ExecutionRequests::default();
        let request = NewPayloadRequest::Daisugi(NewPayloadRequestDaisugi {
            execution_payload: &payload,
            versioned_hashes: vec![],
            parent_beacon_block_root: Hash256::ZERO,
            execution_requests: &execution_requests,
        });
        assert!(matches!(
            request.verify_payload_block_hash(),
            Err(Error::BlockHashMismatch { .. })
        ));
    }

    #[test]
    fn block_hash_matches_nethermind() {
        let payload = ExecutionPayloadDaisugi::<MainnetEthSpec> {
            parent_hash: ExecutionBlockHash::from_root(hash(
                "0xff483e972a04a9a62bb4b7d04ae403c615604e4090521ecc5bb7af67f71be09c",
            )),
            fee_recipient: Address::from_str("0x475674cb523a0a2736b7f7534390288fce16982c").unwrap(),
            state_root: hash("0x69e39af32bd0cc2d5f8ad822a3afcd7fe8d7211e4ca7c42654cdbda7a9b74516"),
            receipts_root: hash(
                "0x837399e622967f92f2ba0d0ab8b41d1b497ed52a31354c945bd675f2657d6dcf",
            ),
            logs_bloom: Default::default(),
            prev_randao: hash("0xad2a4a272ddbd5d85e1e9e2521655beccf3c64d39c4405a411c4e4843b2cf6f4"),
            block_number: 42,
            gas_limit: 60_000_000,
            gas_used: 21_000,
            timestamp: 1_800_000_000,
            extra_data: vec![0xab].try_into().unwrap(),
            base_fee_per_gas: types::Uint256::from(7u64),
            block_hash: ExecutionBlockHash::zero(),
            transactions: transactions()
                .into_iter()
                .map(|tx| tx.try_into().unwrap())
                .collect::<Vec<_>>()
                .try_into()
                .unwrap(),
            withdrawals: Default::default(),
            blob_gas_used: 0,
            excess_blob_gas: 0,
            recursive_stark_proof: vec![0x4e, 0x4c, 0x52, 0x33, 1, 2, 3].try_into().unwrap(),
        };
        let (block_hash, transactions_root) = calculate_execution_block_hash(
            ExecutionPayloadRef::Daisugi(&payload),
            Some(hash(
                "0xff009f228d26ce2afcaca65d94a08d506400415ecfa8dacebf425a25d453485b",
            )),
            Some(&ExecutionRequests::<MainnetEthSpec>::default()),
        );
        assert_eq!(
            transactions_root,
            hash("0x85378e169f975d6784134feacb957ee57f34ab3516078d4e9ecd369163da2669")
        );
        assert_eq!(
            block_hash,
            ExecutionBlockHash::from_root(hash(
                "0x5c2e89e3a132ec21f25e1ea4d58884c8ec33205a5faf6ddf1c03cb9ca113d5b5"
            ))
        );
    }
}

/// The first Daisugi block of a local devnet (Nethermind `c07cd8bf18` with the Lean backend, this
/// Lighthouse at `d4a14a025`), as the beacon API served it: the block hash Nethermind assigned must be
/// reproduced from the payload alone.
#[cfg(test)]
mod devnet_test {
    use crate::calculate_execution_block_hash;
    use serde::Deserialize;
    use types::{
        ExecutionPayloadDaisugi, ExecutionPayloadRef, ExecutionRequests, Hash256, MainnetEthSpec,
    };

    #[derive(Deserialize)]
    struct Block {
        payload: ExecutionPayloadDaisugi<MainnetEthSpec>,
        parent_beacon_block_root: Hash256,
        execution_requests: ExecutionRequests<MainnetEthSpec>,
    }

    fn assert_block_hash_is_reproduced(fixture: &str) {
        let block: Block = serde_json::from_str(fixture).unwrap();
        let (hash, _) = calculate_execution_block_hash(
            ExecutionPayloadRef::Daisugi(&block.payload),
            Some(block.parent_beacon_block_root),
            Some(&block.execution_requests),
        );
        assert_eq!(hash, block.payload.block_hash);
    }

    #[test]
    fn first_devnet_block_hash_is_reproduced() {
        assert_block_hash_is_reproduced(include_str!(
            "test_fixtures/daisugi_devnet_first_block.json"
        ));
    }

    /// A frame transaction with a leanSig dependency bound to its signature hash and a leanSTARK dependency, carrying
    /// the producer's 326624-byte recursive proof.
    #[test]
    fn proof_bearing_devnet_block_hash_is_reproduced() {
        assert_block_hash_is_reproduced(include_str!(
            "test_fixtures/daisugi_devnet_proof_block.json"
        ));
    }
}
