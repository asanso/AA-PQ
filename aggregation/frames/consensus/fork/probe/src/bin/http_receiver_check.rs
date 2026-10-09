//! Private transport test against the real native Engine payload handler.
use execution_layer::{HttpJsonRpc,NewPayloadRequestDaisugi,PayloadStatusV1Status,
    json_structures::JsonExecutionPayloadDaisugi,calculate_execution_block_hash};
use types::*;
use ssz::{Encode,Decode};
use std::{env,fs,time::Duration};
type E=MinimalEthSpec;

#[tokio::main(flavor="multi_thread",worker_threads=2)]
async fn main() {
    let args:Vec<String>=env::args().collect();
    assert_eq!(args.len(),3,"usage: http_receiver_check LOOPBACK_URL FIXTURE_DIRECTORY");
    assert!(args[1].starts_with("http://127.0.0.1:"),"private loopback endpoint required");
    let client=HttpJsonRpc::new(args[1].parse().unwrap(),None).unwrap();
    let requests=ExecutionRequests::<E>::default();
    for (index,scenario) in ["valid-first","corrupt-proof","missing-proof","changed-commitment","valid-second"].into_iter().enumerate() {
        let block_index=if index==0 {0} else {1};
        let original:JsonExecutionPayloadDaisugi<E>=serde_json::from_slice(&fs::read(format!("{}/wallet-block-{block_index}-engine.json",args[2])).unwrap()).unwrap();
        let original:ExecutionPayloadDaisugi<E>=original.try_into().unwrap();
        let mut payload=ExecutionPayloadDaisugi::<E>::from_ssz_bytes(&original.as_ssz_bytes()).unwrap();
        if scenario=="corrupt-proof" {
            let mut bytes=payload.recursive_stark_proof.bytes().to_vec();*bytes.last_mut().unwrap()^=1;
            payload.recursive_stark_proof=bytes.try_into().unwrap();
        }
        if scenario=="changed-commitment" { payload.recursive_stark_block_deps_hash=Hash256::repeat_byte(1); }
        if scenario=="corrupt-proof" || scenario=="changed-commitment" {
            payload.block_hash=calculate_execution_block_hash(ExecutionPayloadRef::Daisugi(&payload),Some(Hash256::ZERO),Some(&requests)).0;
        }
        if scenario=="missing-proof" {
            let json:JsonExecutionPayloadDaisugi<E>=payload.try_into().unwrap();
            let mut json=serde_json::to_value(json).unwrap();json.as_object_mut().unwrap().remove("recursiveStarkProof");
            let response:serde_json::Value=client.rpc_request("engine_newPayloadV4",serde_json::json!([json,[],Hash256::ZERO,[]]),Duration::from_secs(8)).await.unwrap();
            assert_eq!(response["status"],"INVALID");
        } else {
            let result=client.new_payload_v4_daisugi(NewPayloadRequestDaisugi{
                execution_payload:&payload,versioned_hashes:vec![],parent_beacon_block_root:Hash256::ZERO,execution_requests:&requests
            }).await.unwrap();
            assert_eq!(result.status,if index==0 || index==4 {PayloadStatusV1Status::Valid} else {PayloadStatusV1Status::Invalid},"{scenario}: {result:?}");
        }
        println!("{scenario}: passed");
    }
}
