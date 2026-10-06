use leanvm::{SphincsClaim, sphincs, sphincs_deps_hash, verify_sphincs_deps};
use serde::Deserialize;
use serde_json::json;
use std::{fs, io::Write, path::Path, time::Instant};

const MAX_INPUT: u64 = 1024 * 1024;
const MAX_PROOF: u64 = 1024 * 1024;
const MAX_CLAIMS: usize = 16;
const PROFILE: &str = "leanvm-f33f31bf-sphincs-block-deps";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    public_key: String,
    message: String,
    #[serde(default)]
    signature: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    profile: String,
    claims: Vec<Claim>,
}

fn decode<const N: usize>(text: &str) -> Result<[u8; N], String> {
    let raw = text.strip_prefix("0x").ok_or("Hex prefix is required")?;
    if raw.len() != 2 * N {
        return Err("Invalid hexadecimal length".into());
    }
    let mut output = [0; N];
    hex::decode_to_slice(raw, &mut output).map_err(|_| "Invalid hexadecimal value")?;
    Ok(output)
}

fn read(path: &str, limit: u64) -> Result<Vec<u8>, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > limit {
        return Err("Input exceeds the development limit".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}

fn claims(input: &Input) -> Result<Vec<SphincsClaim>, String> {
    if input.profile != PROFILE || input.claims.is_empty() || input.claims.len() > MAX_CLAIMS {
        return Err("Unsupported profile or claim count".into());
    }
    input
        .claims
        .iter()
        .map(|claim| {
            Ok((
                decode(&claim.message)?,
                sphincs::SphincsPublicKey::from_bytes(&decode(&claim.public_key)?),
            ))
        })
        .collect()
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Rejected: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || !["hash", "signatures", "prove", "verify"].contains(&args[1].as_str()) {
        return Err(
            "Usage: daisugi-block-deps-probe hash|signatures|prove|verify INPUT.json PROOF.bin"
                .into(),
        );
    }
    let input: Input =
        serde_json::from_slice(&read(&args[2], MAX_INPUT)?).map_err(|e| e.to_string())?;
    let expected = claims(&input)?;
    let commitment = sphincs_deps_hash(&expected);
    let started = Instant::now();
    let mut proof_bytes = 0;
    match args[1].as_str() {
        "hash" => {}
        "signatures" | "prove" => {
            let mut signatures = Vec::with_capacity(expected.len());
            for (claim, (message, key)) in input.claims.iter().zip(&expected) {
                let bytes = decode::<{ sphincs::SIG_SIZE }>(
                    claim.signature.as_deref().ok_or("Missing signature")?,
                )?;
                let signature = sphincs::SphincsSignature::from_bytes(&bytes);
                sphincs::verify(key, message, &signature)
                    .map_err(|_| "Invalid wallet signature")?;
                signatures.push((*key, *message, signature));
            }
            if args[1] == "prove" {
                if Path::new(&args[3]).exists() {
                    return Err("Proof output already exists".into());
                }
                leanvm::setup_prover_without_arena();
                let proof = leanvm::aggregate(&[], vec![], signatures, &[], None, 2)
                    .map_err(|e| e.to_string())?;
                let encoded = proof.to_bytes_without_pubkeys();
                if encoded.len() as u64 > MAX_PROOF {
                    return Err("Proof exceeds the development limit".into());
                }
                verify_sphincs_deps(&commitment, &encoded).map_err(|e| e.to_string())?;
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&args[3])
                    .map_err(|e| e.to_string())?;
                output.write_all(&encoded).map_err(|e| e.to_string())?;
                proof_bytes = encoded.len();
            }
        }
        "verify" => {
            let proof = read(&args[3], MAX_PROOF)?;
            if proof.is_empty() {
                return Err("Empty proof".into());
            }
            leanvm::setup_verifier();
            verify_sphincs_deps(&commitment, &proof).map_err(|e| e.to_string())?;
            proof_bytes = proof.len();
        }
        _ => unreachable!(),
    }
    println!(
        "{}",
        json!({"profile": PROFILE, "action": args[1], "accepted": true,
        "claims": expected.len(), "blockDepsHash": format!("0x{}", hex::encode(commitment)),
        "proofBytes": proof_bytes, "elapsedMs": started.elapsed().as_millis()})
    );
    Ok(())
}
