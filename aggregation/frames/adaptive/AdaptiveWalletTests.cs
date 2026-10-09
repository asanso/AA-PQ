// SPDX-FileCopyrightText: 2026 Demerzel Solutions Limited
// SPDX-License-Identifier: LGPL-3.0-only

using System;
using Nethermind.Evm;
using Nethermind.Evm.State;
using Nethermind.State;
using System.Threading;
using System.Threading.Tasks;
using Autofac;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Extensions;
using Nethermind.Core.Specs;
using Nethermind.Core.Test.Blockchain;
using Nethermind.Core.Test.Builders;
using Nethermind.Consensus.Validators;
using Nethermind.Consensus.ProofAggregation;
using Nethermind.Int256;
using Nethermind.Specs;
using Nethermind.Specs.Forks;
using Nethermind.TxPool;
using NUnit.Framework;

namespace Nethermind.Crypto.LeanFfi.Test;

[NonParallelizable]
public class AdaptiveWalletTests
{
    private static class AdaptiveSpec
    {
        public static readonly ReleaseSpec Instance = Create();
        private static ReleaseSpec Create()
        {
            ReleaseSpec spec = Prague.Instance.Clone();
            spec.Name = "DaisugiAdaptivePrivateTest";
            spec.IsEip8141Enabled = true;
            spec.IsEip8288Enabled = true;
            spec.IsEip8250Enabled = true;
            spec.IsEip8272Enabled = true;
            spec.IsEip7906Enabled = true;
            spec.IsEip7843Enabled = true;
            spec.IsDaisugiAdaptiveAggregationEnabled = true;
            return spec;
        }
    }
#nullable enable
    private static readonly Address DaisugiRecipient = new("0xda1500000000000000000000000000000000c001");

    private static System.Text.Json.JsonElement DaisugiFixture(int index)
    {
        string root = Environment.GetEnvironmentVariable("DAISUGI_AUTH_DIR")
            ?? throw new InvalidOperationException("DAISUGI_AUTH_DIR is required");
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(
            System.IO.File.ReadAllText(System.IO.Path.Combine(root, "fixtures", "authorization.json")));
        return document.RootElement.GetProperty("fixtures")[index].Clone();
    }

    private static Transaction DaisugiTransaction(int index)
    {
        System.Text.Json.JsonElement input = DaisugiFixture(index).GetProperty("transaction");
        System.Collections.Generic.List<TxFrame> frames = [];
        foreach (System.Text.Json.JsonElement item in input.GetProperty("frames").EnumerateArray())
        {
            string? target = item.GetProperty("target").GetString();
            frames.Add(new TxFrame((FrameMode)item.GetProperty("mode").GetByte(),
                (FrameFlags)item.GetProperty("flags").GetByte(), target is null ? null : new Address(target),
                item.GetProperty("executionGas").GetUInt64(), item.GetProperty("stateGas").GetUInt64(),
                UInt256.Parse(item.GetProperty("value").GetString()!),
                Convert.FromHexString(item.GetProperty("data").GetString()![2..])));
        }
        Transaction transaction = new()
        {
            Type = TxType.FrameTx,
            ChainId = ulong.Parse(input.GetProperty("chainId").GetString()!),
            SenderAddress = new Address(input.GetProperty("sender").GetString()!),
            Nonce = ulong.Parse(input.GetProperty("nonce").GetString()!),
            NonceKeys = [UInt256.Zero],
            FrameSignatures = [],
            Frames = [.. frames],
            GasPrice = UInt256.Parse(input.GetProperty("maxPriorityFee").GetString()!),
            DecodedMaxFeePerGas = UInt256.Parse(input.GetProperty("maxFee").GetString()!),
            MaxFeePerBlobGas = UInt256.Zero,
            GasLimit = FrameTxValidation.TotalGasLimit([.. frames])
        };
        transaction.Hash = transaction.CalculateHash();
        return transaction;
    }

    private sealed class DaisugiTestBlockchain : BasicTestBlockchain
    {
        public Task Initialize(Action<ContainerBuilder> configure) => Build(configure);
        protected override Nethermind.Consensus.IBlockProducer CreateTestBlockProducer()
            => new DaisugiTestProducer(this, BlockProducerEnvFactory.CreatePersistent(), BlocksConfig);
    }

    private sealed class DaisugiTestProducer(TestBlockchain chain, Nethermind.Consensus.IBlockProducerEnv environment,
        Nethermind.Config.IBlocksConfig config) : TestBlockProducer(environment.TxSource, environment.ChainProcessor,
            environment.ReadOnlyStateProvider, chain.Container.Resolve<Nethermind.Consensus.ISealer>(), chain.BlockTree,
            chain.Timestamper, chain.SpecProvider, chain.LogManager, config)
    {
        protected override BlockHeader PrepareBlockHeader(BlockHeader parent, Nethermind.Consensus.Producers.PayloadAttributes? attributes = null)
        {
            BlockHeader header = base.PrepareBlockHeader(parent, attributes);
            // Match upstream PostMergeBlockProducer's blob-field preparation while retaining test sealing.
            header.BlobGasUsed = 0;
            header.ExcessBlobGas = BlobGasCalculator.CalculateExcessBlobGas(parent, chain.SpecProvider.GetSpec(header));
            return header;
        }
    }

    private static async Task<BasicTestBlockchain> DaisugiChain(LeanProofStore proofs)
    {
        DaisugiTestBlockchain chain = new();
        await chain.Initialize(builder => builder
            .AddSingleton<ISpecProvider>(new SingleReleaseSpecProvider(AdaptiveSpec.Instance, 1337, 1337))
            .AddSingleton<ILeanProofVerifier, VersionedLeanProofVerifier>()
            .AddSingleton(proofs)
            .AddSingleton<IUnclesValidator, UnclesValidator>()
            .AddScoped<Nethermind.Blockchain.IGenesisPostProcessor, Nethermind.Evm.State.IWorldState, ISpecProvider>((state, provider) =>
                new Nethermind.Core.Test.Container.FunctionalGenesisPostProcessor(_ =>
                {
                    for (int index = 0; index < 2; index++)
                    {
                        System.Text.Json.JsonElement fixture = DaisugiFixture(index);
                        Address account = new(fixture.GetProperty("transaction").GetProperty("sender").GetString()!);
                        state.CreateAccount(account, UInt256.Parse("10000000000000000000"));
                        state.InsertCode(account, Convert.FromHexString(fixture.GetProperty("runtime").GetString()![2..]), provider.GenesisSpec);
                    }
                    state.CreateAccount(DaisugiRecipient, UInt256.Zero);
                    state.InsertCode(DaisugiRecipient, Convert.FromHexString("60003560005500"), provider.GenesisSpec);
                    state.RecalculateStateRoot();
                })));
        return chain;
    }

    private static void DaisugiAddWitness(LeanProofStore proofs, Transaction transaction, int index, bool unrelated = false)
    {
        System.Text.Json.JsonElement fixture = DaisugiFixture(index);
        byte[] witness = Convert.FromHexString(fixture.GetProperty(unrelated ? "unrelatedWitness" : "witness").GetString()![2..]);
        System.Collections.Generic.List<FrameDependency> dependencies = Eip8288Dependencies.ForTransaction(transaction);
        Assert.That(dependencies, Has.Count.EqualTo(1));
        FrameDependency dependency = dependencies[0];
        Assert.That(NativeLeanProofVerifier.Instance.VerifyLeanSphincs(dependency.DataHash, dependency.VerificationKey, witness), Is.True);
        proofs.AddVerified(dependencies, [witness], null);
    }

    [Test]
    public async Task Adaptive_wallet_signatures_are_batched_executed_and_verified_in_a_block()
    {
        LeanProofStore proofs = new();
        using BasicTestBlockchain chain = await DaisugiChain(proofs);
        ILeanProofVerifier selected = chain.Container.Resolve<ILeanProofVerifier>();
        Assert.That(chain.SpecProvider.GetSpec(chain.BlockTree.Head!.Header).IsDaisugiAdaptiveAggregationEnabled, Is.True, "Test chain specification");
        using (VersionedLeanProofVerifier direct = new(chain.SpecProvider, chain.BlockFinder))
            Assert.That(direct.AdaptiveBatchingEnabled, Is.True, "Direct production verifier");
        Assert.That(selected.AdaptiveBatchingEnabled, Is.True, selected.GetType().FullName);
        Assert.That(selected.ProductionVerificationKey.ToArray(), Is.EqualTo(AdaptiveProofProgram.VerificationKey.ToArray()));
        Assert.That(chain.Container.Resolve<ProofWrapperService>().AdaptiveBatchingEnabled, Is.True);
        Assert.That(chain.SpecProvider.GetSpec(chain.BlockTree.Head!.Header).IsDaisugiAdaptiveAggregationEnabled, Is.True);
        for (int index = 0; index < 2; index++)
        {
            Transaction transaction = DaisugiTransaction(index);
            Assert.That(chain.TxPool.SubmitTx(transaction, TxHandlingOptions.None).ToString(), Does.Contain("MissingDependencyProof"));
            byte[] witness = Convert.FromHexString(DaisugiFixture(index).GetProperty("witness").GetString()![2..]);
            MempoolWrapper wrapper = new()
            {
                Transactions = [new WrapperTransaction(transaction)],
                Mode = MempoolWrapper.ModeDirect,
                Deps = Eip8288Dependencies.ForTransaction(transaction),
                Proofs = [witness]
            };
            byte[] encoded = new MempoolWrapperDecoder().Encode(wrapper).Bytes;
            Result<Hash256[]> admission = await chain.Container.Resolve<ProofWrapperService>().AcceptAsync(encoded);
            Assert.That(admission.IsSuccess, Is.True, admission.Error);
            ValidationResult wellFormed = new TxValidator(1337).IsWellFormed(transaction, AdaptiveSpec.Instance);
            Assert.That((bool)wellFormed, Is.True, wellFormed.ToString());

        }
        using CancellationTokenSource budget = new(TimeSpan.FromMinutes(3));
        ProofWrapperService wrapperService = chain.Container.Resolve<ProofWrapperService>();
        Result produced = Result.Fail("not ready");
        for (int attempt = 0; attempt < 100 && !produced; attempt++)
        {
            produced = wrapperService.RefreshWrapper(budget.Token);
            if (!produced) await Task.Delay(50, budget.Token);
        }
        Assert.That((bool)produced, Is.True, produced.Error);
        BlockHeader parent = chain.BlockTree.Head!.Header;
        Block block = await chain.BlockProducer.BuildBlock(parentHeader: parent,
            payloadAttributes: new Nethermind.Consensus.Producers.PayloadAttributes
            {
                Timestamp = parent.Timestamp + 1,
                Withdrawals = [],
                ParentBeaconBlockRoot = Keccak.Zero,
                PrevRandao = Keccak.Zero,
                SlotNumber = (parent.SlotNumber ?? 0) + 1
            }, cancellationToken: budget.Token) ?? throw new InvalidOperationException("No block was produced");
        Assert.That(chain.Container.Resolve<IBlockValidator>().ValidateSuggestedBlock(block, parent, out string? blockError),
            Is.True, blockError);
        Assert.That(chain.BlockTree.SuggestBlock(block, Nethermind.Blockchain.BlockTreeSuggestOptions.ForceDontSetAsMain),
            Is.EqualTo(Nethermind.Blockchain.AddBlockResult.Added));
        Assert.That(chain.BlockchainProcessor.Process(block, Nethermind.Consensus.Processing.ProcessingOptions.StoreReceipts,
            Nethermind.Blockchain.Tracing.NullBlockTracer.Instance), Is.Not.Null);
        Assert.That(block.Transactions, Has.Length.EqualTo(2));
        Assert.That(block.Header.RecursiveStark, Is.Not.Null);
        ValueHash256 commitment = Eip8288Dependencies.ComputeBlockDepsHash(block);
        Assert.That(new NativeAdaptiveProofVerifier().VerifyRecursiveStark(commitment,
            AdaptiveProofProgram.VerificationKey, block.Header.RecursiveStark!.StarkProof), Is.True);
        using (BasicTestBlockchain receiver = await DaisugiChain(new LeanProofStore()))
        {
            Assert.That(receiver.BlockTree.Head!.Hash, Is.EqualTo(parent.Hash));
            Block received = Nethermind.Serialization.Rlp.Rlp.Decode<Block>(Nethermind.Serialization.Rlp.Rlp.Encode(block).Bytes)
                ?? throw new InvalidOperationException("Block decoding failed");
            Assert.That(receiver.Container.Resolve<IBlockValidator>().ValidateSuggestedBlock(received, receiver.BlockTree.Head!.Header, out string? receiveError), Is.True, receiveError);
            Assert.That(receiver.BlockTree.SuggestBlock(received, Nethermind.Blockchain.BlockTreeSuggestOptions.ForceDontSetAsMain), Is.EqualTo(Nethermind.Blockchain.AddBlockResult.Added));
            Assert.That(receiver.BlockchainProcessor.Process(received, Nethermind.Consensus.Processing.ProcessingOptions.StoreReceipts,
                Nethermind.Blockchain.Tracing.NullBlockTracer.Instance), Is.Not.Null);
            Assert.That(receiver.ReceiptStorage.Get(received), Has.Length.EqualTo(2));
        }
        TxReceipt[] receipts = chain.ReceiptStorage.Get(block);
        Assert.That(receipts, Has.Length.EqualTo(2));
        using (chain.MainWorldState.BeginScope(block.Header))
        using (Assert.EnterMultipleScope())
        {
            Assert.That(chain.MainWorldState.GetBalance(DaisugiRecipient), Is.EqualTo(UInt256.Parse("200000000000000")));
            chain.MainWorldState.Get(new StorageCell(DaisugiRecipient, UInt256.Zero), out UInt256 stored);
            Assert.That(stored, Is.EqualTo(new UInt256(block.Transactions[^1].Frames![2].Data.Span, isBigEndian: true)));
            for (int index = 0; index < 2; index++)
            {
                Assert.That(receipts[index].StatusCode, Is.EqualTo(StatusCode.Success));
                Assert.That(receipts[index].FrameReceipts, Has.Length.EqualTo(3));
                foreach (TxFrameReceipt receipt in receipts[index].FrameReceipts!)
                    Assert.That(receipt.Status, Is.EqualTo(StatusCode.Success));
                Assert.That(block.Transactions[index].FrameSignatures, Is.Empty);
                Assert.That(chain.MainWorldState.GetNonce(block.Transactions[index].SenderAddress!), Is.EqualTo(1));
            }
        }
        string root = Environment.GetEnvironmentVariable("DAISUGI_AUTH_DIR")!;
        System.IO.File.WriteAllBytes(System.IO.Path.Combine(root, "accepted-block-proof.bin"), block.Header.RecursiveStark.StarkProof);
        byte[] encodedBlock = Nethermind.Serialization.Rlp.Rlp.Encode(block).Bytes;
        System.IO.File.WriteAllBytes(System.IO.Path.Combine(root, "accepted-block.rlp"), encodedBlock);
        System.IO.File.WriteAllText(System.IO.Path.Combine(root, "accepted-block.json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            blockHash = block.Hash!.ToString(),
            transactionHashes = Array.ConvertAll(block.Transactions, transaction => transaction.Hash!.ToString()),
            proofBytes = block.Header.RecursiveStark.StarkProof.Length,
            proofSha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(block.Header.RecursiveStark.StarkProof)),
            commitment = commitment.ToString(),
            gasUsed = block.GasUsed,
            receipts = Array.ConvertAll(receipts, receipt => new
            {
                receipt.GasUsed,
                receipt.StatusCode,
                frames = Array.ConvertAll(receipt.FrameReceipts!, frame => new { frame.Status, frame.ExecutionGasUsed, frame.StateGasUsed })
            }),
            scope = "In-memory production modules; not a Daisugi network block"
        }));
    }

}
