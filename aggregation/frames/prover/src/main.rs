use daisugi_frame_aggregation::{
    Claim, MAX_PROOF_BYTES, REVISION, Request, SCHEME, expected_claims, signature_inputs,
    verify_proof,
};
use leanvm::{ClaimSelection, EthereumProof, SignatureClaims};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Child {
    claims: Vec<Claim>,
    proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    scheme: String,
    claims: Vec<Claim>,
    #[serde(default)]
    proof: Option<String>,
    #[serde(default)]
    children: Vec<Child>,
}

fn decode_proof(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_PROOF_BYTES * 2 + 2 {
        return Err("Proof exceeds the byte limit".into());
    }
    hex::decode(
        encoded
            .strip_prefix("0x")
            .ok_or("Proof must start with 0x")?,
    )
    .map_err(|_| "Invalid proof encoding".into())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4
        || !["verify-signatures", "prove", "verify", "compose"].contains(&args[1].as_str())
    {
        return Err("Usage: daisugi-frame-aggregation <verify-signatures|prove|verify|compose> INPUT.json OUTPUT.json".into());
    }
    let limit = (MAX_PROOF_BYTES * 10 + 256 * 1024) as u64;
    let mut data = Vec::new();
    File::open(&args[2])?
        .take(limit + 1)
        .read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err("Input exceeds the request limit".into());
    }
    let envelope: Envelope = serde_json::from_slice(&data)?;
    let request = Request {
        schema_version: envelope.schema_version,
        scheme: envelope.scheme,
        claims: envelope.claims,
        proof: envelope.proof,
    };
    let expected = expected_claims(&request)?;
    let started = Instant::now();
    let mut output = serde_json::json!({"schemaVersion": 1, "scheme": SCHEME,
        "leanVmRevision": REVISION, "claimCount": expected.len(), "childCount": envelope.children.len()});
    if args[1] != "compose" && !envelope.children.is_empty() {
        return Err("Children are only accepted for composition".into());
    }
    match args[1].as_str() {
        "verify-signatures" => {
            if request.proof.is_some() {
                return Err("Unexpected proof".into());
            }
            signature_inputs(&request)?;
            output["individualSignaturesVerified"] = true.into();
        }
        "verify" => {
            let raw = decode_proof(request.proof.as_deref().ok_or("Proof is required")?)?;
            leanvm::setup_verifier();
            verify_proof(&raw, &expected)?;
            output["proofBytes"] = raw.len().into();
            output["verified"] = true.into();
        }
        "prove" | "compose" => {
            if request.proof.is_some() {
                return Err("Unexpected output proof in input".into());
            }
            let mut children = Vec::new();
            let mut raw_inputs = Vec::new();
            if args[1] == "prove" {
                raw_inputs = signature_inputs(&request)?;
                leanvm::setup_prover_without_arena();
            } else {
                if envelope.children.is_empty() || envelope.children.len() > 4 {
                    return Err("Composition requires between one and four children".into());
                }
                if request.claims.iter().any(|claim| claim.signature.is_some()) {
                    return Err("Composition does not accept raw signatures".into());
                }
                leanvm::setup_prover_without_arena();
                let mut covered = BTreeSet::new();
                for child in envelope.children {
                    let child_request = Request {
                        schema_version: 1,
                        scheme: SCHEME.into(),
                        claims: child.claims,
                        proof: None,
                    };
                    let claims = expected_claims(&child_request)?;
                    let raw = decode_proof(&child.proof)?;
                    verify_proof(&raw, &claims)?;
                    covered.extend(claims);
                    children.push(EthereumProof::from_bytes(&raw)?);
                }
                if expected.iter().any(|claim| !covered.contains(claim)) {
                    return Err("Selected claims are not covered by verified children".into());
                }
            }
            let selected = SignatureClaims {
                xmss: vec![],
                sphincs: expected.clone(),
            };
            let selection = ClaimSelection {
                signatures: &selected,
                da_commitments: &[],
            };
            let proving = Instant::now();
            let proof = leanvm::aggregate(&children, vec![], raw_inputs, &[], Some(selection), 2)?;
            output["provingMilliseconds"] = (proving.elapsed().as_millis() as u64).into();
            let raw = proof.to_bytes();
            let verifying = Instant::now();
            verify_proof(&raw, &expected)?;
            output["verificationMilliseconds"] = (verifying.elapsed().as_millis() as u64).into();
            output["proof"] = format!("0x{}", hex::encode(&raw)).into();
            output["proofBytes"] = raw.len().into();
            output["verified"] = true.into();
        }
        _ => unreachable!(),
    }
    output["elapsedMilliseconds"] = (started.elapsed().as_millis() as u64).into();
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[3])?;
    destination.write_all(serde_json::to_string_pretty(&output)?.as_bytes())?;
    destination.write_all(b"\n")?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Frame aggregation failed: {error}");
        std::process::exit(1);
    }
}
