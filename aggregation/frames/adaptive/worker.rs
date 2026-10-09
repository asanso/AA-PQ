// SPDX-License-Identifier: LGPL-3.0-only
//! Private-pipe worker. No listener, RPC endpoint, signing key or network access.
use std::io::{self, Read, Write};

const MAX_INPUT: usize = 18 * 1024 * 1024;
const MAX_PROOF: usize = 8 * 1024 * 1024;

mod nethermind_lean {
    #[link(name = "nethermind_lean_adaptive")]
    unsafe extern "C" {
        pub fn nlean_prove_recursive(hash: *const u8, key: *const u8, key_len: usize,
            input: *const u8, input_len: usize, out: *mut *mut u8, out_len: *mut usize) -> i32;
        pub fn nlean_free(ptr: *mut u8, len: usize);
    }
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut length = [0u8; 4];
        match input.read_exact(&mut length) {
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            result => result?,
        }
        let length = u32::from_le_bytes(length) as usize;
        if length > MAX_INPUT { return Err(io::Error::other("Request exceeds input bound")); }
        let mut hash = [0u8; 32];
        let mut key = [0u8; 32];
        input.read_exact(&mut hash)?;
        input.read_exact(&mut key)?;
        let mut request = vec![0; length];
        input.read_exact(&mut request)?;
        let mut proof = std::ptr::null_mut();
        let mut proof_len = 0;
        let valid = unsafe {
            nethermind_lean::nlean_prove_recursive(hash.as_ptr(), key.as_ptr(), 32,
                request.as_ptr(), length, &mut proof, &mut proof_len)
        } == 1 && !proof.is_null() && proof_len > 0 && proof_len <= MAX_PROOF;
        let bytes = if valid { unsafe { std::slice::from_raw_parts(proof, proof_len) }.to_vec() } else { vec![] };
        if !proof.is_null() { unsafe { nethermind_lean::nlean_free(proof, proof_len) }; }
        output.write_all(&[u8::from(valid)])?;
        output.write_all(&(bytes.len() as u32).to_le_bytes())?;
        output.write_all(&bytes)?;
        output.flush()?;
    }
}
