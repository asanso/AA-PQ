//! Full signed beacon-block production and import through a real private execution engine.
use beacon_chain::test_utils::{BeaconChainHarness, EphemeralHarnessType, BlockStrategy, AttestationStrategy};
use execution_layer::{HttpJsonRpc, NewPayloadRequest, json_structures::JsonExecutionPayloadDaisugi};
use genesis::InteropGenesisBuilder;
use types::*;
use std::{env, sync::Arc, time::Duration};

type E = MinimalEthSpec;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = env::args().collect();
    assert_eq!(args.len(), 2, "usage: beacon_engine_check PRIVATE_LOOPBACK_URL");
    assert!(args[1].starts_with("http://127.0.0.1:"));
    let client = HttpJsonRpc::new(args[1].parse().unwrap(), None).unwrap();
    let initial: JsonExecutionPayloadDaisugi<E> = client.rpc_request("test_genesis",
        serde_json::json!([]), Duration::from_secs(10)).await.unwrap();
    let payload: ExecutionPayloadDaisugi<E> = initial.try_into().unwrap();
    let mut spec = ForkName::Daisugi.make_genesis_spec(E::default_spec()).set_slot_duration_ms::<E>(2000);
    spec.daisugi_fork_version = [0xd0, 1, 2, 3];
    spec.max_payload_size = 20 * 1024 * 1024;
    let keys = types::test_utils::generate_deterministic_keypairs(64);
    let state = InteropGenesisBuilder::new()
        .set_execution_payload_header(ExecutionPayloadHeader::Daisugi((&payload).into()))
        .build_genesis_state(&keys, payload.timestamp, Hash256::repeat_byte(0x42), &spec).unwrap();
    let harness = BeaconChainHarness::<EphemeralHarnessType<E>>::builder(MinimalEthSpec)
        .spec(Arc::new(spec)).deterministic_keypairs(64)
        .genesis_state_ephemeral_store(state).execution_layer_from_url(&args[1]).build();
    assert!(harness.mock_execution_layer.is_none());
    let mut included = 0;
    let mut records = Vec::new();
    harness.advance_slot();
    for _ in 0..6 {
        harness.extend_chain(1, BlockStrategy::OnCanonicalHead, AttestationStrategy::AllValidators).await;
        let head = harness.chain.store.get_full_block(&harness.head_block_root()).unwrap().unwrap();
        let message = head.message();
        let execution = NewPayloadRequest::try_from(message).unwrap().into_execution_payload();
        let data = execution.as_daisugi().unwrap();
        included += data.transactions.len();
        records.push(serde_json::json!({"slot": message.slot().as_u64(),
            "beaconRoot": head.canonical_root(), "executionHash":data.block_hash,
            "transactions":data.transactions.len(), "proofBytes":data.recursive_stark_proof.bytes().len()}));
        if included == 2 { break; }
        tokio::time::sleep(Duration::from_secs(2)).await;
        if harness.get_current_slot() <= harness.head_slot() { harness.advance_slot(); }
    }
    assert_eq!(included, 2);
    let result: serde_json::Value = client.rpc_request("test_finish", serde_json::json!([]),
        Duration::from_secs(10)).await.unwrap();
    assert_eq!(result["transactions"], 2);
    println!("{}", serde_json::json!({"passed":true,"blocks":records,"execution":result}));
}
