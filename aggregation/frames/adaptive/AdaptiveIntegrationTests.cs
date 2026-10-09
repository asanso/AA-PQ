// SPDX-License-Identifier: LGPL-3.0-only
using System;
using System.IO;
using System.Text.Json;
using System.Text;
using Nethermind.Blockchain.Find;
using Nethermind.Consensus.ProofAggregation;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Specs;
using Nethermind.Specs.Forks;
using Nethermind.Specs.ChainSpecStyle;
using Nethermind.Serialization.Json;
using NSubstitute;
using NUnit.Framework;

namespace Nethermind.Crypto.LeanFfi.Test;

[NonParallelizable]
public class AdaptiveIntegrationTests
{
    [TestCase(1337ul, true, 99ul, false)]
    [TestCase(1337ul, true, 100ul, true)]
    [TestCase(1337ul, true, 101ul, true)]
    [TestCase(1337ul, false, 101ul, false)]
    [TestCase(1ul, true, 101ul, false)]
    public void Activation_is_explicit_and_does_not_rewrite_historical_rules(ulong chainId, bool scheduled, ulong timestamp, bool expected)
    {
        string activation = scheduled ? ",\"daisugiAdaptiveAggregationTime\":100" : "";
        string json = $$$"""
        {"config":{"chainId":{{{chainId}}},"homesteadBlock":0,"eip150Block":0,"eip155Block":0,
        "eip158Block":0,"byzantiumBlock":0,"constantinopleBlock":0,"petersburgBlock":0,
        "istanbulBlock":0,"berlinBlock":0,"londonBlock":0,"terminalTotalDifficulty":0,
        "terminalTotalDifficultyPassed":true,"shanghaiTime":0,"cancunTime":0,"pragueTime":0,
        "eip8141PrototypeTime":10,"eip8288PrototypeTime":20{{{activation}}}},
        "difficulty":"0x0","gasLimit":"0x3938700","timestamp":"0x0","alloc":{}}
        """;
        using MemoryStream stream = new(Encoding.UTF8.GetBytes(json));
        ChainSpec loaded = new GethGenesisLoader(new EthereumJsonSerializer()).Load(stream);
        ChainSpecBasedSpecProvider provider = new(loaded);
        Assert.That(provider.GetSpec((1ul, timestamp)).IsDaisugiAdaptiveAggregationEnabled, Is.EqualTo(expected));
        Assert.That(provider.GetSpec((1ul, 19ul)).IsEip8288Enabled, Is.False);
        Assert.That(provider.GetSpec((1ul, 20ul)).IsEip8288Enabled, Is.True);
    }

    private static string Root => Environment.GetEnvironmentVariable("DAISUGI_ADAPTIVE_FIXTURES")!;
    private static VersionedLeanProofVerifier Verifier(bool enabled)
    {
        IBlockFinder blocks = Substitute.For<IBlockFinder>();
        BlockHeader header = new(Keccak.Zero, Keccak.OfAnEmptySequenceRlp, Address.Zero,
            Nethermind.Int256.UInt256.Zero, 1, 60_000_000, 1, []);
        blocks.Head.Returns(new Block(header));
        return new(new SingleReleaseSpecProvider(new AdaptiveSpec(enabled), 1337, 1337), blocks);
    }

    private sealed class AdaptiveSpec(bool enabled) : ReleaseSpecDecorator(Eip8288Prototype.Instance)
    {
        public override bool IsDaisugiAdaptiveAggregationEnabled => enabled;
    }

    [TestCase(false)]
    [TestCase(true)]
    public void Historical_proofs_remain_valid_and_new_proofs_require_activation(bool active)
    {
        using VersionedLeanProofVerifier verifier = Verifier(active);
        verifier.EnsureAvailable();
        using JsonDocument input = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "proofs.json")));
        foreach (JsonElement entry in input.RootElement.EnumerateArray())
        {
            byte[] proof = File.ReadAllBytes(Path.Combine(Root, entry.GetProperty("file").GetString()!));
            ValueHash256 commitment = new(entry.GetProperty("commitment").GetString()!);
            bool legacy = entry.GetProperty("legacy").GetBoolean();
            Assert.That(verifier.VerifyKnownRecursiveStark(in commitment, proof), Is.EqualTo(active ? !legacy : legacy));
            Assert.That(verifier.VerifyBlockRecursiveStark(in commitment, proof, false), Is.EqualTo(legacy));
            Assert.That(verifier.VerifyBlockRecursiveStark(in commitment, proof, true), Is.True);
            Assert.That(verifier.VerifyBlockRecursiveStark(default, proof, true), Is.False);
            byte[] corrupt = (byte[])proof.Clone();
            corrupt[^1] ^= 1;
            Assert.That(verifier.VerifyBlockRecursiveStark(in commitment, corrupt, true), Is.False);
            Assert.That(verifier.VerifyBlockRecursiveStark(in commitment, proof.AsSpan(0, proof.Length - 1), true), Is.False);
        }
    }

    [Test]
    public void Persistent_worker_rebuilds_and_verifies_two_complete_proofs()
    {
        using AdaptiveProofWorker worker = new();
        NativeAdaptiveProofVerifier verifier = new();
        using JsonDocument requests = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "worker-requests.json")));
        foreach (JsonElement request in requests.RootElement.EnumerateArray())
        {
            ValueHash256 hash = new(request.GetProperty("commitment").GetString()!);
            byte[] payload = Convert.FromHexString(request.GetProperty("input").GetString()!);
            byte[] proof = worker.Prove(hash.Bytes, AdaptiveProofProgram.VerificationKey, payload);
            Assert.That(verifier.VerifyRecursiveStark(in hash, AdaptiveProofProgram.VerificationKey, proof), Is.True);
            Assert.That(NativeLeanProofVerifier.Instance.VerifyRecursiveStark(in hash, Eip8288Constants.AggregatedVk, proof), Is.False);
        }
    }

    [Test]
    public void Bad_worker_request_fails_closed_then_next_process_recovers()
    {
        using AdaptiveProofWorker worker = new();
        Assert.Throws<InvalidOperationException>(() => worker.Prove(new byte[32], AdaptiveProofProgram.VerificationKey, [0, 0, 0, 0]));
        ValueHash256 empty = Eip8288Dependencies.ComputeDepsHash([]);
        byte[] proof = worker.Prove(empty.Bytes, AdaptiveProofProgram.VerificationKey, new byte[12]);
        Assert.That(new NativeAdaptiveProofVerifier().VerifyRecursiveStark(in empty, AdaptiveProofProgram.VerificationKey, proof), Is.True);
    }

    [Test]
    public void Full_batch_starts_immediately_but_partial_batch_preserves_formation_time()
    {
        AdaptiveBatchPolicy policy = new();
        Assert.That(policy.Ready(10, 40, 12), Is.True);
        policy.Reset();
        Assert.That(policy.Ready(10, 1, 12), Is.False);
        Assert.That(policy.Ready(10.49, 39, 12), Is.False);
        Assert.That(policy.Ready(10.5, 39, 12), Is.True);
    }

    [Test]
    public void Partial_batch_eventually_dispatches_without_waiting_for_forty_users()
    {
        AdaptiveBatchPolicy policy = new();
        Assert.That(policy.Ready(10, 1, 12), Is.False);
        Assert.That(policy.Ready(11.8, 1, 12), Is.True);
        policy.Completed(12, 1, 0.2);
        Assert.That(policy.Ready(12, 1, 14), Is.False);
        Assert.That(policy.Ready(14, 1, 16), Is.True);
    }

    [Test]
    public void Queue_empty_resets_formation_and_invalid_counts_are_rejected()
    {
        AdaptiveBatchPolicy policy = new();
        policy.Ready(10, 1, 12);
        Assert.That(policy.Ready(11, 0, 12), Is.False);
        Assert.That(policy.Ready(11.8, 1, 12), Is.False);
        Assert.Throws<ArgumentOutOfRangeException>(() => policy.Ready(10, 41, 12));
        Assert.Throws<ArgumentOutOfRangeException>(() => policy.Completed(10, 0, 1));
    }

    [Test]
    public void Prepared_input_does_not_replace_pinned_raw_witnesses()
    {
        LeanProofStore store = new();
        FrameDependency first = new(0x10, new ValueHash256("0x" + new string('1', 64)), default);
        FrameDependency second = new(0x10, new ValueHash256("0x" + new string('2', 64)), default);
        store.AddVerified([first, second], [new byte[6208], new byte[6208]], null);
        store.AddCachedRecursive([first, second], [1, 2, 3]);
        Assert.That(store.TryGetPreparedInput([first], out AggregationInput prepared), Is.True);
        Assert.That(prepared.RecursiveProofs, Has.Count.EqualTo(1));
        Assert.That(prepared.RecursiveProofs[0].InnerDeps, Has.Count.EqualTo(2));
        Assert.That(store.TryGetInput([first], out AggregationInput direct), Is.True);
        Assert.That(direct.Deps, Has.Count.EqualTo(1));
        Assert.That(store.TryGetPreparedInput([new(0x10, default, default)], out _), Is.False);
        store.ClearCachedRecursive();
        Assert.That(store.TryGetPreparedInput([first], out _), Is.False);
        Assert.That(store.TryGetInput([first], out direct), Is.True);
        Assert.That(direct.Deps, Has.Count.EqualTo(1));
    }
}
