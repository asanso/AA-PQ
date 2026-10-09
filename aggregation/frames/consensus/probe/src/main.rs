use execution_layer::aggregate_json::JsonAggregateExecutionPayload;
use serde_json::Value;
use sha2::{Digest, Sha256};
use ssz::{Decode, Encode};
use std::{env, fs, path::Path};
use tree_hash::TreeHash;
use types::{AggregateExecutionPayload, MainnetEthSpec as E};

fn round_trip(input: &Path, output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let source: Value = serde_json::from_slice(&fs::read(input)?)?;
    let json: JsonAggregateExecutionPayload<E> = serde_json::from_value(source.clone())?;
    let payload: AggregateExecutionPayload<E> = json.try_into().map_err(|e| format!("{e:?}"))?;
    let proof_hash = hex::encode(Sha256::digest(payload.recursive_stark_proof.bytes()));
    let header = payload.to_header();
    assert_eq!(header.tree_hash_root(), payload.tree_hash_root());
    let encoded = payload.as_ssz_bytes();
    fs::create_dir_all(output)?;
    fs::write(output.join("payload.ssz"), &encoded)?;
    drop(payload);
    let restored = AggregateExecutionPayload::<E>::from_ssz_bytes(&fs::read(output.join("payload.ssz"))?)
        .map_err(|e| format!("{e:?}"))?;
    assert!(header.accepts(&restored));
    let context_path = input.with_file_name(input.file_name().unwrap().to_str().unwrap().replace("-engine.json", "-engine-context.json"));
    let mut checked_block_hash = false;
    if context_path != input && context_path.exists() {
        let context: Value = serde_json::from_slice(&fs::read(context_path)?)?;
        let parent_root: types::Hash256 = serde_json::from_value(context["parentBeaconBlockRoot"].clone())?;
        let requests: execution_layer::json_structures::JsonExecutionRequests = serde_json::from_value(context["executionRequests"].clone())?;
        let requests: types::ExecutionRequests<E> = requests.try_into().map_err(|e| format!("{e:?}"))?;
        let computed = execution_layer::aggregate_block_hash::aggregate_execution_block_hash(&restored, parent_root, &requests)?;
        assert_eq!(computed, restored.payload.block_hash);
        checked_block_hash = true;
    }
    let proof_bytes = restored.recursive_stark_proof.bytes().len();
    fs::write(output.join("proof.bin"), restored.recursive_stark_proof.bytes())?;
    let round_trip: Value = serde_json::to_value(JsonAggregateExecutionPayload::try_from(restored)
        .map_err(|e| format!("{e:?}"))?)?;
    assert_eq!(source, round_trip);
    fs::write(output.join("engine-payload.json"), serde_json::to_vec_pretty(&round_trip)?)?;
    let result = serde_json::json!({
        "exactEngineRoundTrip": true, "proofBytes": proof_bytes, "proofSha256": proof_hash,
        "fullAndBlindedRoot": format!("{:#x}", header.tree_hash_root()), "sszBytes": encoded.len(), "checkedBlockHash": checked_block_hash,
        "scope": "Real Lighthouse types and Engine JSON adapters; local file round trip, not beacon-node networking or activation"
    });
    fs::write(output.join("result.json"), serde_json::to_vec_pretty(&result)?)?;
    println!("{result}");
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 { return Err("Usage: daisugi-consensus-transport-checks INPUT_JSON OUTPUT_DIRECTORY".into()); }
    round_trip(Path::new(&args[1]), Path::new(&args[2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use execution_layer::json_structures::JsonExecutionPayloadElectra;
    use types::{ExecutionPayloadElectra, Hash256, RecursiveProof, MAX_RECURSIVE_PROOF_BYTES};

    fn sample() -> AggregateExecutionPayload<E> {
        AggregateExecutionPayload {
            payload: ExecutionPayloadElectra::default(),
            recursive_stark_proof: vec![1, 2, 3].try_into().unwrap(),
            recursive_stark_block_deps_hash: Hash256::repeat_byte(7),
        }
    }
    fn json() -> Value { serde_json::to_value(JsonAggregateExecutionPayload::try_from(sample()).unwrap()).unwrap() }
    fn parse(value: Value) -> bool { serde_json::from_value::<JsonAggregateExecutionPayload<E>>(value).is_ok() }

    #[test] fn complete_engine_json_round_trip() {
        let source = json();
        let restored: AggregateExecutionPayload<E> = serde_json::from_value::<JsonAggregateExecutionPayload<E>>(source.clone()).unwrap().try_into().unwrap();
        assert_eq!(source, serde_json::to_value(JsonAggregateExecutionPayload::try_from(restored).unwrap()).unwrap());
    }
    #[test] fn upstream_engine_schema_drops_the_proof() {
        let original = json();
        let current: JsonExecutionPayloadElectra<E> = serde_json::from_value(original.clone()).unwrap();
        let current = serde_json::to_value(current).unwrap();
        assert!(original.get("recursiveStarkProof").is_some());
        assert!(current.get("recursiveStarkProof").is_none());
        assert!(current.get("recursiveStarkBlockDepsHash").is_none());
    }
    #[test] fn full_and_blinded_roots_match() { let p = sample(); assert!(p.to_header().accepts(&p)); }
    #[test] fn changed_proof_invalidates_header() {
        let mut p = sample(); let h = p.to_header(); p.recursive_stark_proof = vec![1, 2, 4].try_into().unwrap(); assert!(!h.accepts(&p));
    }
    #[test] fn changed_commitment_invalidates_header() {
        let mut p = sample(); let h = p.to_header(); p.recursive_stark_block_deps_hash = Hash256::repeat_byte(8); assert!(!h.accepts(&p));
    }
    #[test] fn changed_base_payload_invalidates_header() {
        let mut p = sample(); let h = p.to_header(); p.payload.gas_used = 1; assert!(!h.accepts(&p));
    }
    #[test] fn ssz_round_trip_preserves_complete_payload() {
        let p = sample(); assert_eq!(AggregateExecutionPayload::<E>::from_ssz_bytes(&p.as_ssz_bytes()).unwrap(), p);
    }
    #[test] fn legacy_payload_bytes_are_unchanged() {
        let before = sample().payload; let encoded = before.as_ssz_bytes(); let root = before.tree_hash_root();
        let extended = AggregateExecutionPayload { payload: before, ..sample() };
        assert_eq!(extended.payload.as_ssz_bytes(), encoded); assert_eq!(extended.payload.tree_hash_root(), root);
        assert!(AggregateExecutionPayload::<E>::from_ssz_bytes(&encoded).is_err());
        assert!(ExecutionPayloadElectra::<E>::from_ssz_bytes(&extended.as_ssz_bytes()).is_err());
    }
    #[test] fn missing_proof_is_rejected() { let mut v=json(); v.as_object_mut().unwrap().remove("recursiveStarkProof"); assert!(!parse(v)); }
    #[test] fn null_proof_is_rejected() { let mut v=json(); v["recursiveStarkProof"]=Value::Null; assert!(!parse(v)); }
    #[test] fn empty_proof_is_rejected() { let mut v=json(); v["recursiveStarkProof"]="0x".into(); assert!(!parse(v)); }
    #[test] fn malformed_proof_hex_is_rejected() { let mut v=json(); v["recursiveStarkProof"]="0xzz".into(); assert!(!parse(v)); }
    #[test] fn missing_commitment_is_rejected() { let mut v=json(); v.as_object_mut().unwrap().remove("recursiveStarkBlockDepsHash"); assert!(!parse(v)); }
    #[test] fn invalid_commitment_width_is_rejected() { let mut v=json(); v["recursiveStarkBlockDepsHash"]="0x07".into(); assert!(!parse(v)); }
    #[test] fn invalid_base_payload_is_rejected() { let mut v=json(); v["blockHash"]="0x01".into(); assert!(!parse(v)); }
    #[test] fn empty_ssz_proof_is_rejected() { assert!(RecursiveProof::from_ssz_bytes(&[]).is_err()); }
    #[test] fn oversized_proof_is_rejected() {
        assert!(RecursiveProof::try_from(vec![0; MAX_RECURSIVE_PROOF_BYTES + 1]).is_err());
        assert!(RecursiveProof::from_ssz_bytes(&vec![0; MAX_RECURSIVE_PROOF_BYTES + 1]).is_err());
    }
    #[test] fn maximum_sized_proof_is_preserved() {
        let proof=RecursiveProof::try_from(vec![1; MAX_RECURSIVE_PROOF_BYTES]).unwrap();
        assert_eq!(RecursiveProof::from_ssz_bytes(&proof.as_ssz_bytes()).unwrap(), proof);
    }
    #[test] fn truncated_ssz_payload_is_rejected() { let mut b=sample().as_ssz_bytes(); b.truncate(38); assert!(AggregateExecutionPayload::<E>::from_ssz_bytes(&b).is_err()); }
}
