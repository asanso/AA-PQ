//! Private full-fork integration checks. No live network or validator keys are used.
#[cfg(test)]
mod tests {
    use execution_layer::{json_structures::{JsonExecutionPayloadDaisugi, JsonExecutionPayloadBodyV1},
        calculate_execution_block_hash, ExecutionPayloadBodyV1, NewPayloadRequest};
    use ssz::{Decode, Encode};
    use tree_hash::TreeHash;
    use types::*;
    use std::{fs, env};
    type E = MinimalEthSpec;

    #[test]
    fn finalized_daisugi_state_and_signature_survive_the_candidate_upgrade() {
        type M = MainnetEthSpec;
        let directory = env::var("DAISUGI_PUBLIC_STATE").unwrap();
        let capture: serde_json::Value = serde_json::from_slice(&fs::read(format!("{directory}/capture.json")).unwrap()).unwrap();
        let config: Config = serde_json::from_slice(&fs::read(format!("{directory}/spec.json")).unwrap()).unwrap();
        let mut spec = config.apply_to_chain_spec::<M>(&M::default_spec()).unwrap();
        assert!(spec.daisugi_fork_epoch.is_none());
        let bytes = fs::read(format!("{directory}/state.ssz")).unwrap();
        let mut state = BeaconState::<M>::from_ssz_bytes(&bytes, &spec).unwrap();
        assert_eq!(state.fork_name_unchecked(), ForkName::Electra);
        assert_eq!(state.as_ssz_bytes(), bytes);
        let root: Hash256 = capture["header"]["header"]["message"]["state_root"].as_str().unwrap().parse().unwrap();
        assert_eq!(state.canonical_root().unwrap(), root);
        let block_bytes = fs::read(format!("{directory}/block.ssz")).unwrap();
        let block = SignedBeaconBlock::<M>::from_ssz_bytes(&block_bytes, &spec).unwrap();
        assert_eq!(block.as_ssz_bytes(), block_bytes);
        assert_eq!(block.canonical_root(), capture["header"]["root"].as_str().unwrap().parse::<Hash256>().unwrap());
        let proposer = state.validators().get(block.message().proposer_index() as usize).unwrap();
        assert!(block.verify_signature(None, &proposer.pubkey.decompress().unwrap(), &state.fork(), state.genesis_validators_root(), &spec));
        let mut before = serde_json::to_value(&state).unwrap();
        let original_hash = state.latest_execution_payload_header().unwrap().block_hash();
        // This activation exists only in this offline test and is never installed.
        spec.daisugi_fork_epoch = Some(state.current_epoch());
        spec.daisugi_fork_version = [0xd0, 0x01, 0x02, 0x03];
        state_processing::upgrade::upgrade_to_daisugi(&mut state, &spec).unwrap();
        let mut after = serde_json::to_value(&state).unwrap();
        for field in ["fork", "latest_execution_payload_header"] {
            before.as_object_mut().unwrap().remove(field);
            after.as_object_mut().unwrap().remove(field);
        }
        assert_eq!(before, after);
        assert_eq!(state.latest_execution_payload_header().unwrap().block_hash(), original_hash);
        let upgraded_root = state.canonical_root().unwrap();
        let mut restored = BeaconState::<M>::from_ssz_bytes(&state.as_ssz_bytes(), &spec).unwrap();
        assert_eq!(restored.canonical_root().unwrap(), upgraded_root);
        assert_ne!(upgraded_root, root);
    }

    fn frame_bytes(keyed: bool, hashes: Vec<Vec<u8>>) -> Vec<u8> {
        fn list(parts: Vec<Vec<u8>>) -> Vec<u8> {
            let data=parts.concat(); let mut bytes=Vec::new();
            alloy_rlp::Header {list:true,payload_length:data.len()}.encode(&mut bytes);
            bytes.extend(data);bytes
        }
        let mut fields=vec![alloy_rlp::encode(1337u64)];
        if keyed { fields.push(list(vec![alloy_rlp::encode(0u64)])); }
        fields.extend([alloy_rlp::encode(0u64),alloy_rlp::encode([1u8;20].as_slice()),list(vec![]),list(vec![]),
            list(vec![alloy_rlp::encode(0u64);3]),list(hashes.into_iter().map(|h|alloy_rlp::encode(h.as_slice())).collect())]);
        let mut bytes=vec![6];bytes.extend(list(fields));bytes
    }
    fn extract_frame(bytes: Vec<u8>) -> Result<Vec<VersionedHash>,execution_layer::versioned_hashes::Error> {
        let txs:Transactions<E>=vec![bytes.try_into().unwrap()].try_into().unwrap();
        execution_layer::versioned_hashes::extract_versioned_hashes_from_transactions::<E>(&txs)
    }
    #[test] fn scalar_and_keyed_frame_blob_hashes_preserve_order() {
        let hashes=vec![vec![1;32],vec![2;32]];
        for keyed in [false,true] {
            assert_eq!(extract_frame(frame_bytes(keyed,hashes.clone())).unwrap(),
                       vec![Hash256::repeat_byte(1),Hash256::repeat_byte(2)]);
        }
    }
    #[test] fn malformed_frame_envelopes_are_rejected() {
        let valid=frame_bytes(true,vec![]);
        for end in 0..valid.len() { assert!(extract_frame(valid[..end].to_vec()).is_err()); }
        let mut trailing=valid.clone();trailing.push(0);assert!(extract_frame(trailing).is_err());
        assert!(extract_frame(frame_bytes(true,vec![vec![1;31]])).is_err());
        let mut unknown=valid;unknown[0]=0x7f;assert!(extract_frame(unknown).is_err());
    }

    fn spec() -> ChainSpec {
        let mut spec = ForkName::Electra.make_genesis_spec(E::default_spec());
        // This version is a test fixture, not a selected activation version.
        spec.daisugi_fork_version = [0xd0, 0x01, 0x02, 0x03];
        spec.daisugi_fork_epoch = Some(Epoch::new(2));
        spec
    }
    fn payload() -> ExecutionPayloadDaisugi<E> {
        ExecutionPayloadDaisugi { recursive_stark_proof: vec![1,2,3,4].try_into().unwrap(),
            recursive_stark_block_deps_hash: Hash256::repeat_byte(7), ..Default::default() }
    }
    fn body(p: &ExecutionPayloadDaisugi<E>) -> ExecutionPayloadBodyV1<E> {
        ExecutionPayloadBodyV1 { transactions: p.transactions.clone(), withdrawals: Some(p.withdrawals.clone()),
            recursive_stark_proof: Some(p.recursive_stark_proof.clone()),
            recursive_stark_block_deps_hash: Some(p.recursive_stark_block_deps_hash) }
    }
    #[test] fn native_persisted_body_reconstructs_the_original_execution_payload() {
        let root=env::var("DAISUGI_TRANSPORT_FIXTURES").unwrap();
        let bodies=env::var("DAISUGI_BODY_FIXTURES").unwrap();
        for name in ["wallet-block-0","wallet-block-1","empty-block"] {
            let json:JsonExecutionPayloadDaisugi<E>=serde_json::from_slice(&fs::read(format!("{root}/{name}-engine.json")).unwrap()).unwrap();
            let payload:ExecutionPayloadDaisugi<E>=json.try_into().unwrap();
            let response:Vec<JsonExecutionPayloadBodyV1<E>>=serde_json::from_slice(&fs::read(format!("{bodies}/{name}-body.json")).unwrap()).unwrap();
            assert_eq!(response.len(),1);
            let body:ExecutionPayloadBodyV1<E>=response.into_iter().next().unwrap().try_into().unwrap();
            let restored=body.to_payload(ExecutionPayloadHeader::Daisugi((&payload).into())).unwrap();
            use store::StoreItem;
            assert_eq!(ExecutionPayload::<E>::from_store_bytes(&restored.as_store_bytes()).unwrap(),restored);
            assert_eq!(restored,ExecutionPayload::Daisugi(payload));
        }
    }

    // This exercises real CL state processing, fork choice and disk storage. Its
    // execution endpoint is a mock and does not establish native proof validity.
    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn beacon_chain_crosses_fork_and_reopens_its_disk_database() {
        use beacon_chain::test_utils::{BeaconChainHarness,DiskHarnessType,BlockStrategy,AttestationStrategy};
        use store::{HotColdDB,StoreConfig,database::interface::BeaconNodeBackend};
        use std::sync::Arc;
        let directory=tempfile::tempdir().unwrap();
        let spec=spec();
        let open=|| HotColdDB::<E,BeaconNodeBackend,BeaconNodeBackend>::open(
            &directory.path().join("hot"),&directory.path().join("cold"),&directory.path().join("blobs"),
            |_,_,_|Ok(()),StoreConfig {prune_payloads:false,..Default::default()},Arc::new(spec.clone())).unwrap();
        let database=open();
        let harness=BeaconChainHarness::<DiskHarnessType<E>>::builder(MinimalEthSpec)
            .spec(Arc::new(spec.clone())).deterministic_keypairs(64)
            .fresh_disk_store(database.clone()).mock_execution_layer().build();
        harness.advance_slot();
        harness.extend_chain(20,BlockStrategy::OnCanonicalHead,AttestationStrategy::AllValidators).await;
        assert_eq!(harness.get_current_state().fork_name(&spec).unwrap(),ForkName::Daisugi);
        let head=harness.head_block_root();
        let full=harness.chain.store.get_full_block(&head).unwrap().unwrap();
        assert_eq!(full.fork_name_unchecked(),ForkName::Daisugi);
        let clock=harness.chain.slot_clock.clone();
        harness.chain.persist_fork_choice().unwrap();
        harness.chain.persist_op_pool().unwrap();
        drop(harness);drop(database);
        let reopened=open();
        let recovered=reopened.get_full_block(&head).unwrap().unwrap();
        assert_eq!(recovered,full);
        let resumed=BeaconChainHarness::<DiskHarnessType<E>>::builder(MinimalEthSpec)
            .spec(Arc::new(spec.clone())).deterministic_keypairs(64)
            .resumed_disk_store(reopened).testing_slot_clock(clock).mock_execution_layer().build();
        assert_eq!(resumed.head_block_root(),head);
        assert_eq!(resumed.get_current_state().fork_name(&spec).unwrap(),ForkName::Daisugi);
    }
    fn block(p: ExecutionPayloadDaisugi<E>) -> SignedBeaconBlock<E> {
        let spec = spec();
        let mut block = BeaconBlockDaisugi::<E>::empty(&spec);
        block.body.execution_payload.execution_payload = p;
        let key = types::test_utils::generate_deterministic_keypair(0);
        let fork = Fork { previous_version: spec.electra_fork_version, current_version: spec.daisugi_fork_version, epoch: Epoch::new(2) };
        BeaconBlock::Daisugi(block).sign(&key.sk, &fork, Hash256::ZERO, &spec)
    }
    #[test] fn default_schedule_does_not_activate_daisugi() {
        assert_eq!(E::default_spec().daisugi_fork_epoch, None);
        assert!(ForkName::Daisugi.electra_enabled());
        assert!(!ForkName::Daisugi.fulu_enabled());
        assert!(!ForkName::Daisugi.gloas_enabled());
    }
    #[test] fn historical_fork_tags_remain_stable() {
        for (n, fork) in [ForkName::Base,ForkName::Altair,ForkName::Bellatrix,ForkName::Capella,
            ForkName::Deneb,ForkName::Electra,ForkName::Fulu,ForkName::Gloas,ForkName::Daisugi].into_iter().enumerate() {
            assert_eq!(fork.as_ssz_bytes(), vec![n as u8]);
            assert_eq!(ForkName::from_ssz_bytes(&[n as u8]).unwrap(), fork);
        }
    }
    #[test] fn activation_boundary_and_digest_are_explicit() {
        let spec=spec();
        assert_eq!(spec.fork_name_at_epoch(Epoch::new(1)),ForkName::Electra);
        assert_eq!(spec.fork_name_at_epoch(Epoch::new(2)),ForkName::Daisugi);
        assert_eq!(spec.next_fork_epoch::<E>(Slot::new(8)),Some((ForkName::Daisugi,Epoch::new(2))));
        assert_eq!(spec.next_digest_epoch(Epoch::new(1)),Some(Epoch::new(2)));
        assert_eq!(spec.next_digest_epoch(Epoch::new(2)),None);
        let ctx=ForkContext::new::<E>(Slot::new(16),Hash256::ZERO,&spec);
        assert_eq!(ctx.current_fork_name(),ForkName::Daisugi);
        assert_ne!(spec.compute_fork_digest(Hash256::ZERO,Epoch::new(1)),ctx.current_fork_digest());
    }
    #[test] fn ambiguous_configurations_are_rejected() {
        let base=spec();
        for mode in 0..4 {
            let mut s=base.clone();
            match mode { 0=>s.daisugi_fork_version=[0;4], 1=>s.daisugi_fork_version=s.electra_fork_version,
                2=>s.fulu_fork_epoch=Some(Epoch::new(3)), _=>s.gloas_fork_epoch=Some(Epoch::new(3)) }
            let config=Config::from_chain_spec::<E>(&s);
            assert!(config.apply_to_chain_spec::<E>(&base).is_none());
        }
        assert!(Config::from_chain_spec::<E>(&base).apply_to_chain_spec::<E>(&base).is_some());
    }
    #[test] fn full_signed_block_and_blinded_block_have_same_root() {
        let full=block(payload()); let blind=full.clone_as_blinded();
        assert_eq!(full.tree_hash_root(),blind.tree_hash_root());
        let decoded=SignedBeaconBlock::<E>::from_ssz_bytes(&full.as_ssz_bytes(),&spec()).unwrap();
        assert_eq!(decoded,full);
        let key=types::test_utils::generate_deterministic_keypair(0);
        let spec=spec(); let fork=Fork {previous_version:spec.electra_fork_version,current_version:spec.daisugi_fork_version,epoch:Epoch::new(2)};
        assert!(decoded.verify_signature(None,&key.pk,&fork,Hash256::ZERO,&spec));
        let (blinded,payload):(SignedBlindedBeaconBlock<E>,_)=decoded.into();
        assert_eq!(blinded.try_into_full_block(payload).unwrap(),full);
    }
    #[test] fn full_block_rejects_wrong_fork_decode() {
        let full=block(payload());
        let old=ForkName::Electra.make_genesis_spec(E::default_spec());
        assert!(SignedBeaconBlock::<E>::from_ssz_bytes(&full.as_ssz_bytes(),&old).is_err());
    }
    #[test] fn gossip_encoding_uses_daisugi_digest_and_preserves_proof() {
        use lighthouse_network::{PubsubMessage, GossipTopic, TopicHash};
        use lighthouse_network::types::{GossipKind,GossipEncoding};
        let full=block(payload());let ctx=ForkContext::new::<E>(Slot::new(16),Hash256::ZERO,&spec());
        let message=PubsubMessage::BeaconBlock(std::sync::Arc::new(full.clone()));
        let encoded=message.encode(GossipEncoding::SSZSnappy);
        let topic=GossipTopic::new(GossipKind::BeaconBlock,GossipEncoding::SSZSnappy,ctx.current_fork_digest());
        let decoded=PubsubMessage::<E>::decode(&TopicHash::from_raw(topic.to_string()),&encoded,&ctx).unwrap();
        let PubsubMessage::BeaconBlock(decoded)=decoded else {panic!("wrong gossip type")};
        assert_eq!(*decoded,full);
        let wrong=GossipTopic::new(GossipKind::BeaconBlock,GossipEncoding::SSZSnappy,[0xff;4]);
        assert!(PubsubMessage::<E>::decode(&TopicHash::from_raw(wrong.to_string()),&encoded,&ctx).is_err());
    }
    #[test] fn payload_body_reconstruction_preserves_complete_proof() {
        let p=payload();let header=ExecutionPayloadHeader::Daisugi((&p).into());
        let json:JsonExecutionPayloadBodyV1<E>=body(&p).try_into().unwrap();
        let json=serde_json::to_vec(&json).unwrap();
        let parsed:JsonExecutionPayloadBodyV1<E>=serde_json::from_slice(&json).unwrap();
        let decoded:ExecutionPayloadBodyV1<E>=parsed.try_into().unwrap();
        assert_eq!(decoded.to_payload(header).unwrap(),ExecutionPayload::Daisugi(p));
    }
    #[test] fn missing_or_mismatched_body_proof_is_rejected() {
        let p=payload();let header=ExecutionPayloadHeader::Daisugi((&p).into());
        let mut b=body(&p);b.recursive_stark_proof=None;assert!(b.to_payload(header.clone()).is_err());
        let mut b=body(&p);b.recursive_stark_block_deps_hash=None;assert!(b.to_payload(header.clone()).is_err());
        let mut b=body(&p);b.recursive_stark_proof=Some(vec![9].try_into().unwrap());assert!(b.to_payload(header.clone()).is_err());
        let mut b=body(&p);b.recursive_stark_block_deps_hash=Some(Hash256::ZERO);assert!(b.to_payload(header).is_err());
    }
    #[test] fn engine_json_does_not_default_missing_proof() {
        let p=payload();let j:JsonExecutionPayloadDaisugi<E>=p.try_into().unwrap();
        let j=serde_json::to_value(j).unwrap();
        for field in ["recursiveStarkProof","recursiveStarkBlockDepsHash"] {
            let mut invalid=j.clone();invalid.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<JsonExecutionPayloadDaisugi<E>>(invalid).is_err());
        }
    }
    #[test] fn historical_electra_block_remains_readable_after_activation() {
        let spec=spec();let key=types::test_utils::generate_deterministic_keypair(0);
        let b=BeaconBlock::<E>::Electra(BeaconBlockElectra::empty(&spec));
        let fork=Fork {previous_version:spec.electra_fork_version,current_version:spec.electra_fork_version,epoch:Epoch::new(0)};
        let b=b.sign(&key.sk,&fork,Hash256::ZERO,&spec);
        let decoded=SignedBeaconBlock::<E>::from_ssz_bytes(&b.as_ssz_bytes(),&spec).unwrap();
        assert_eq!(b,decoded);
        assert_eq!(b.message().fork_name_unchecked(),ForkName::Electra);
    }
    #[test] fn real_proofs_survive_signed_block_and_engine_round_trip() {
        let root=env::var("DAISUGI_TRANSPORT_FIXTURES").expect("retained producer fixture directory is required");
        for name in ["wallet-block-0","wallet-block-1","empty-block"] {
            let bytes=fs::read(format!("{root}/{name}-engine.json")).unwrap();
            let original:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
            let j:JsonExecutionPayloadDaisugi<E>=serde_json::from_value(original.clone()).unwrap();
            let p:ExecutionPayloadDaisugi<E>=j.try_into().unwrap();
            let requests=ExecutionRequests::<E>::default();
            let (hash,_)=calculate_execution_block_hash(ExecutionPayloadRef::Daisugi(&p),Some(Hash256::ZERO),Some(&requests));
            assert_eq!(hash,p.block_hash);
            let mut changed=p.clone();changed.recursive_stark_block_deps_hash=Hash256::repeat_byte(1);
            assert_ne!(calculate_execution_block_hash(ExecutionPayloadRef::Daisugi(&changed),Some(Hash256::ZERO),Some(&requests)).0,hash);
            let full=block(p.clone());
            let restored=SignedBeaconBlock::<E>::from_ssz_bytes(&full.as_ssz_bytes(),&spec()).unwrap();
            let request=NewPayloadRequest::try_from(restored.message()).unwrap();
            request.perform_optimistic_sync_verifications().unwrap();
            let restored=request.into_execution_payload();
            let restored:JsonExecutionPayloadDaisugi<E>=restored.as_daisugi().unwrap().clone().try_into().unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(),original);
        }
    }
    #[test] fn electra_state_upgrade_preserves_accounts_and_history() {
        let spec=spec(); let keys=types::test_utils::generate_deterministic_keypairs(64);
        let mut state=genesis::interop_genesis_state::<E>(&keys,0,Hash256::repeat_byte(11),None,&spec).unwrap();
        *state.slot_mut()=Slot::new(16);
        let before=serde_json::to_value(&state).unwrap();
        state_processing::upgrade::upgrade_to_daisugi(&mut state,&spec).unwrap();
        let after=serde_json::to_value(&state).unwrap();
        for (name,value) in before.as_object().unwrap() {
            if name=="fork" || name=="latest_execution_payload_header" {continue;}
            assert_eq!(after.get(name),Some(value),"preserved state field {name}");
        }
        assert_eq!(state.fork_name(&spec).unwrap(),ForkName::Daisugi);
        assert_eq!(state.fork().previous_version,spec.electra_fork_version);
        assert_eq!(state.fork().current_version,spec.daisugi_fork_version);
        let bytes=state.as_ssz_bytes();
        let mut recovered=BeaconState::<E>::from_ssz_bytes(&bytes,&spec).unwrap();
        assert_eq!(recovered.canonical_root().unwrap(),state.canonical_root().unwrap());
    }
}
