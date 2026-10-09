use leanvm::{EthereumProof, SphincsClaim, sphincs};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SCHEME: &str = "daisugi-frame-case7-sphincs-g-v0";
pub const REVISION: &str = "b7b3b742af8dda100a0263b22c36e33963cc165c";
pub const MAX_BATCH: usize = 16;
pub const MAX_PROOF_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub pk_seed: String,
    pub pk_root: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema_version: u32,
    pub scheme: String,
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub proof: Option<String>,
}

pub fn bytes(value: &str, length: usize) -> Result<Vec<u8>, String> {
    let raw = value
        .strip_prefix("0x")
        .ok_or("Hex values must start with 0x")?;
    if raw.len() != length * 2 {
        return Err(format!("Expected {length} bytes"));
    }
    hex::decode(raw).map_err(|_| "Invalid hexadecimal value".into())
}

fn word(value: &str) -> Result<[u8; 16], String> {
    let data = bytes(value, 32)?;
    if data[16..].iter().any(|byte| *byte != 0) {
        return Err("Public key words must have zero low 128 bits".into());
    }
    Ok(data[..16].try_into().unwrap())
}

pub fn expected_claims(request: &Request) -> Result<Vec<SphincsClaim>, String> {
    if request.schema_version != 1 || request.scheme != SCHEME {
        return Err("Unsupported request version or signature scheme".into());
    }
    if request.claims.is_empty() || request.claims.len() > MAX_BATCH {
        return Err(format!(
            "Batch must contain between 1 and {MAX_BATCH} claims"
        ));
    }
    let mut claims = BTreeSet::new();
    for claim in &request.claims {
        let key = sphincs::SphincsPublicKey {
            root: word(&claim.pk_root)?,
            public_param: word(&claim.pk_seed)?,
        };
        let message = bytes(&claim.message, 32)?.try_into().unwrap();
        if !claims.insert((key, message)) {
            return Err("Duplicate key/message claim".into());
        }
    }
    Ok(claims.into_iter().collect())
}

pub fn signature_inputs(
    request: &Request,
) -> Result<
    Vec<(
        sphincs::SphincsPublicKey,
        sphincs::Message,
        sphincs::SphincsSignature,
    )>,
    String,
> {
    expected_claims(request)?;
    request
        .claims
        .iter()
        .map(|claim| {
            let key = sphincs::SphincsPublicKey {
                root: word(&claim.pk_root)?,
                public_param: word(&claim.pk_seed)?,
            };
            let message = bytes(&claim.message, 32)?.try_into().unwrap();
            let raw = bytes(
                claim
                    .signature
                    .as_deref()
                    .ok_or("Individual signature is required")?,
                sphincs::SIG_SIZE,
            )?;
            let signature =
                sphincs::SphincsSignature::from_bytes(raw.as_slice().try_into().unwrap());
            sphincs::verify(&key, &message, &signature)
                .map_err(|_| "Invalid individual signature".to_string())?;
            Ok((key, message, signature))
        })
        .collect()
}

pub fn verify_proof(raw: &[u8], expected: &[SphincsClaim]) -> Result<(), String> {
    if raw.is_empty() || raw.len() > MAX_PROOF_BYTES {
        return Err("Proof size is outside the configured limits".into());
    }
    let proof =
        EthereumProof::from_bytes(raw).map_err(|error| format!("Malformed proof: {error}"))?;
    if proof.sphincs_signers() != expected
        || !proof.xmss_signers().is_empty()
        || !proof.da_commitments().is_empty()
    {
        return Err("Proof claims do not match the expected signature claims".into());
    }
    proof
        .verify()
        .map_err(|error| format!("Proof verification failed: {error}"))
}

/// Isolated feasibility-test ABI. Not a production precompile or client API.
///
/// # Safety
/// Both pointers must reference readable, immutable buffers of their stated
/// lengths for the duration of the call. Returns 0 for acceptance, 1 for rejected
/// input, 2 for a caught panic, and 3 for invalid boundary lengths or pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn case7_verify(
    proof_ptr: *const u8,
    proof_len: usize,
    request_ptr: *const u8,
    request_len: usize,
) -> i32 {
    if proof_ptr.is_null()
        || request_ptr.is_null()
        || proof_len == 0
        || proof_len > MAX_PROOF_BYTES
        || request_len == 0
        || request_len > 2 * 1024 * 1024
    {
        return 3;
    }
    static INIT: std::sync::Once = std::sync::Once::new();
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let result = std::panic::catch_unwind(|| -> Result<(), String> {
        let _lock = LOCK
            .lock()
            .map_err(|_| "Verifier lock poisoned".to_owned())?;
        INIT.call_once(leanvm::setup_verifier);
        let raw = unsafe { std::slice::from_raw_parts(proof_ptr, proof_len) };
        let request_bytes = unsafe { std::slice::from_raw_parts(request_ptr, request_len) };
        let request: Request = serde_json::from_slice(request_bytes).map_err(|e| e.to_string())?;
        let claims = expected_claims(&request)?;
        verify_proof(raw, &claims)
    });
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(_)) => 1,
        Err(_) => 2,
    }
}
