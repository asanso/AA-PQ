// SPDX-License-Identifier: LGPL-3.0-only

using System;
using Nethermind.Blockchain.Find;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Crypto;

namespace Nethermind.Consensus.ProofAggregation;

/// <summary>Preserves the original guest and enables the larger guest only after the configured fork.</summary>
public sealed class VersionedLeanProofVerifier(ISpecProvider specs, IBlockFinder blocks) : ILeanProofVerifier, IDisposable
{
    private readonly ILeanProofVerifier _legacy = NativeLeanProofVerifier.Instance;
    private readonly NativeAdaptiveProofVerifier _adaptive = new();
    private readonly AdaptiveProofWorker _worker = new();
    private bool Active => blocks.Head is { } head && specs.GetSpec(head.Header).IsDaisugiAdaptiveAggregationEnabled;

    public ReadOnlySpan<byte> ProductionVerificationKey => Active ? AdaptiveProofProgram.VerificationKey : Eip8288Constants.AggregatedVk;
    public int MaxDirectSignatures => Active ? AdaptiveBatchPolicy.MaxClaims : 4;
    public bool AdaptiveBatchingEnabled => Active;
    public void EnsureAvailable() { _legacy.EnsureAvailable(); _adaptive.EnsureAvailable(); }

    public bool VerifyLeanSphincs(in ValueHash256 hash, in ValueHash256 key, ReadOnlySpan<byte> witness)
        => _legacy.VerifyLeanSphincs(in hash, in key, witness);
    public bool VerifyLeanStark(in ValueHash256 hash, in ValueHash256 key, ReadOnlySpan<byte> witness)
        => _legacy.VerifyLeanStark(in hash, in key, witness);

    public bool VerifyRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> key, ReadOnlySpan<byte> proof)
        => key.SequenceEqual(AdaptiveProofProgram.VerificationKey)
            ? _adaptive.VerifyRecursiveStark(in hash, key, proof)
            : key.SequenceEqual(Eip8288Constants.AggregatedVk) && _legacy.VerifyRecursiveStark(in hash, key, proof);

    public bool VerifyKnownRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof)
        => VerifyRecursiveStark(in hash, ProductionVerificationKey, proof);

    // The block's specification controls historical acceptance, never the current head.
    public bool VerifyBlockRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof, bool adaptiveEnabled)
        => _legacy.VerifyRecursiveStark(in hash, Eip8288Constants.AggregatedVk, proof)
            || (adaptiveEnabled && _adaptive.VerifyRecursiveStark(in hash, AdaptiveProofProgram.VerificationKey, proof));

    public byte[] ProveRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> key, AggregationInput input)
    {
        if (key.SequenceEqual(Eip8288Constants.AggregatedVk)) return _legacy.ProveRecursiveStark(in hash, key, input);
        if (!Active || !key.SequenceEqual(AdaptiveProofProgram.VerificationKey))
            throw new InvalidOperationException("Adaptive proof production is not active for this chain head.");
        byte[] proof = _worker.Prove(hash.Bytes, key, NativeAdaptiveProofVerifier.SerializeInput(input));
        if (!_adaptive.VerifyRecursiveStark(in hash, key, proof))
            throw new InvalidOperationException("The isolated prover returned an invalid dependency proof.");
        return proof;
    }

    public void Dispose() => _worker.Dispose();
}
