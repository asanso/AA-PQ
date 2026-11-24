//! WebAssembly exports of leanSPHINCS (leanEthereum/leanVM `crates/lean_sphincs` at f7ba4999) for a wallet.
//!
//! A plain C ABI over linear memory, without generated bindings: the host allocates buffers with [`alloc`],
//! writes the inputs, calls an export and reads the outputs. Lengths are fixed by the scheme: a 32-byte seed
//! (`SK.seed`), a 32-byte message, a 32-byte public key (`PK.seed || PK.root`), a 7,740-byte signature.
//!
//! Experimental and not audited. The crate's intermediate secrets are not zeroized; the exports clear only
//! the seed buffer the host passes in.

use lean_sphincs::{LeanSphincsPublicKey, LeanSphincsSignature, PUB_KEY_SIZE, SIG_SIZE, key_gen, sign, verify};

const SEED_LEN: usize = 32;
const MESSAGE_LEN: usize = 32;

/// Reserves `len` bytes of linear memory for the host. Returns a null pointer for a zero length.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

/// Releases a buffer from [`alloc`], zeroing it first.
///
/// # Safety
/// `ptr` and `len` must come from one [`alloc`] call, released once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        core::ptr::write_bytes(ptr, 0, len);
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

unsafe fn read<const N: usize>(ptr: *const u8) -> [u8; N] {
    unsafe { core::ptr::read_unaligned(ptr as *const [u8; N]) }
}

/// The byte lengths this build expects, for the host to check: seed, message, public key, signature.
#[unsafe(no_mangle)]
pub extern "C" fn lean_sphincs_lengths(out: *mut u32) {
    let lengths = [SEED_LEN as u32, MESSAGE_LEN as u32, PUB_KEY_SIZE as u32, SIG_SIZE as u32];
    unsafe { core::ptr::copy_nonoverlapping(lengths.as_ptr(), out, lengths.len()) }
}

/// Writes the public key of the seed at `seed` to `public_key`, then zeroes the seed buffer.
///
/// # Safety
/// `seed` must hold 32 readable and writable bytes and `public_key` 32 writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lean_sphincs_key_gen(seed: *mut u8, public_key: *mut u8) {
    let sk = unsafe { read::<SEED_LEN>(seed) };
    let pk = key_gen(&sk).to_bytes();
    unsafe {
        core::ptr::copy_nonoverlapping(pk.as_ptr(), public_key, PUB_KEY_SIZE);
        core::ptr::write_bytes(seed, 0, SEED_LEN);
    }
}

/// Writes the signature of the 32-byte message at `message` under the seed at `seed` to `signature`, then
/// zeroes the seed buffer. Signing is deterministic.
///
/// # Safety
/// `seed` must hold 32 readable and writable bytes, `message` 32 readable bytes and `signature` 7,740
/// writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lean_sphincs_sign(seed: *mut u8, message: *const u8, signature: *mut u8) {
    let sk = unsafe { read::<SEED_LEN>(seed) };
    let m = unsafe { read::<MESSAGE_LEN>(message) };
    let sig = sign(&sk, &m).to_bytes();
    unsafe {
        core::ptr::copy_nonoverlapping(sig.as_ptr(), signature, SIG_SIZE);
        core::ptr::write_bytes(seed, 0, SEED_LEN);
    }
}

/// Returns 1 if the signature at `signature` verifies for the message and public key, otherwise 0.
///
/// # Safety
/// `public_key` and `message` must hold 32 readable bytes and `signature` 7,740.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lean_sphincs_verify(public_key: *const u8, message: *const u8, signature: *const u8) -> u32 {
    let pk = LeanSphincsPublicKey::from_bytes(&unsafe { read::<PUB_KEY_SIZE>(public_key) });
    let m = unsafe { read::<MESSAGE_LEN>(message) };
    let sig = LeanSphincsSignature::from_bytes(&unsafe { read::<SIG_SIZE>(signature) });
    verify(&pk, &m, &sig) as u32
}
