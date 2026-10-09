// SPDX-License-Identifier: LGPL-3.0-only
#nullable enable
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Nethermind.Blockchain.Find;
using Nethermind.Consensus.ProofAggregation;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Core.Test.Builders;
using Nethermind.Crypto;
using Nethermind.Int256;
using Nethermind.Specs;
using Nethermind.Specs.Forks;
using Nethermind.Specs.Test;
using Nethermind.TxPool;
using NSubstitute;
using NUnit.Framework;

namespace Nethermind.Consensus.Test.ProofAggregation;

public class AdaptiveQueueTests
{
    // Fixed verdicts isolate scheduling behavior; native proof validity is tested separately.
    private sealed class QueueVerifier : ILeanProofVerifier
    {
        public bool AdaptiveBatchingEnabled => true;
        public int MaxDirectSignatures => 64;
        public int ProofCalls { get; private set; }
        public Action? OnProving { get; set; }
        public void EnsureAvailable() { }
        public bool VerifyLeanSphincs(in ValueHash256 hash, in ValueHash256 key, ReadOnlySpan<byte> witness) => true;
        public bool VerifyLeanStark(in ValueHash256 hash, in ValueHash256 key, ReadOnlySpan<byte> witness) => true;
        public bool VerifyRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> key, ReadOnlySpan<byte> proof) => true;
        public byte[] ProveRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> key, AggregationInput input)
        {
            ProofCalls++;
            OnProving?.Invoke();
            return [1];
        }
    }

    private sealed class AdaptiveSpec() : ReleaseSpecDecorator(Eip8288Prototype.Instance)
    {
        public override bool IsDaisugiAdaptiveAggregationEnabled => true;
    }

    [TestCase(false, false)]
    [TestCase(true, false)]
    [TestCase(false, true)]
    public async Task Completed_adaptive_group_is_published_and_retained_only_while_eligible(bool removedDuringProving, bool laterArrivals)
    {
        FrameDependency[] deps = Enumerable.Range(0, 40).Select(i =>
            new FrameDependency(0x10, ValueKeccak.Compute("adaptive-queue-" + i), default)).ToArray();
        deps = Eip8288Dependencies.Canonicalize(deps).ToArray();
        Transaction[] transactions = deps.Select((dependency, i) => new Transaction
        {
            Type = TxType.FrameTx, ChainId = 1337, NonceKeys = [UInt256.Zero],
            SenderAddress = Address.Zero, Nonce = (ulong)i,
            Frames = [new(FrameMode.DepVerify, FrameFlags.None, null, Eip8288Constants.LeanSphincsVerificationGas,
                UInt256.Zero, Eip8288Dependencies.Serialize([dependency]))]
        }).ToArray();
        foreach (Transaction tx in transactions) tx.Hash = tx.CalculateHash();
        Transaction[] pending = laterArrivals ? transactions.Take(25).ToArray() : transactions;
        FrameDependency[] selected = deps.Take(pending.Length).ToArray();
        ITxPool pool = Substitute.For<ITxPool>();
        pool.GetPendingTransactions().Returns(_ => pending);
        pool.GetPendingLightBlobTransactionsBySender().Returns(new Dictionary<AddressAsKey, Transaction[]>());
        pool.TryGetPendingTransaction(Arg.Any<ValueHash256>(), out Arg.Any<Transaction?>()).Returns(call =>
        {
            Transaction? found = Array.Find(pending, tx => tx.Hash!.ValueHash256 == call.Arg<ValueHash256>());
            call[1] = found;
            return found is not null;
        });
        LeanProofStore store = new();
        store.AddVerified(deps, deps.Select(_ => new byte[] { 1 }).ToArray(), null);
        QueueVerifier verifier = new();
        verifier.OnProving = () => { if (removedDuringProving) pending = []; };
        IBlockFinder finder = Substitute.For<IBlockFinder>();
        finder.Head.Returns(Build.A.Block.TestObject);
        ProofWrapperService service = new(pool, new TestSingleReleaseSpecProvider(new AdaptiveSpec()), finder, store, verifier);

        async Task<Result<byte[]>> WaitForBatch()
        {
            Stopwatch timeout = Stopwatch.StartNew();
            Result<byte[]> attempt;
            do
            {
                attempt = service.BuildWrapper();
                if (attempt.IsSuccess) return attempt;
                await Task.Delay(20);
            } while (timeout.Elapsed < TimeSpan.FromSeconds(5));
            Assert.Fail(attempt.Error);
            return attempt;
        }

        if (laterArrivals)
        {
            Assert.That(service.BuildWrapper().IsSuccess, Is.False);
        }
        Result<byte[]> result = laterArrivals ? await WaitForBatch() : service.BuildWrapper();

        Assert.That(verifier.ProofCalls, Is.GreaterThan(0));
        Assert.That(result.IsSuccess, Is.EqualTo(!removedDuringProving));
        Assert.That(store.TryGetRecursiveProof(selected, out _), Is.EqualTo(!removedDuringProving));
        Assert.That(store.TryGetPreparedInput([deps[0]], out _), Is.EqualTo(!removedDuringProving));
        Assert.That(store.TryGetInput(deps, out AggregationInput witnesses), Is.True);
        Assert.That(witnesses.Deps, Has.Count.EqualTo(40));
        if (laterArrivals)
        {
            int completed = verifier.ProofCalls;
            pending = transactions;
            Result<byte[]> retained = service.BuildWrapper();
            Assert.That(retained.IsSuccess, Is.True);
            Assert.That(retained.Data, Is.EqualTo(result.Data));
            Assert.That(verifier.ProofCalls, Is.EqualTo(completed), "do not prove an overlapping group while the first group awaits inclusion");
            pending = transactions.Skip(25).ToArray();
            Assert.That((await WaitForBatch()).IsSuccess, Is.True);
            Assert.That(verifier.ProofCalls, Is.EqualTo(completed + 1));
            Assert.That(store.TryGetRecursiveProof(deps.Skip(25).ToArray(), out _), Is.True);
        }
    }
}
