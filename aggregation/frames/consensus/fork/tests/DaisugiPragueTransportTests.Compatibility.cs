#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Autofac;
using Nethermind.Blockchain;
using Nethermind.Blockchain.Tracing;
using Nethermind.Consensus.Processing;
using Nethermind.Consensus.ProofAggregation;
using Nethermind.Consensus.Validators;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Core.Test.Blockchain;
using Nethermind.Core.Test.Builders;
using Nethermind.Evm.State;
using Nethermind.Evm;
using Nethermind.Evm.TransactionProcessing;
using Nethermind.Int256;
using Nethermind.JsonRpc;
using Nethermind.Logging;
using Nethermind.Serialization.Json;
using Nethermind.Serialization.Rlp;
using Nethermind.Specs;
using Nethermind.Specs.ChainSpecStyle;
using Nethermind.TxPool;
using NUnit.Framework;

namespace Nethermind.Crypto.LeanFfi.Test;

public partial class DaisugiPragueTransportTests
{
    private static string CompatibilityRoot => Environment.GetEnvironmentVariable("DAISUGI_COMPATIBILITY_DIR")!;
    private static async Task<Block> CompatibilityBlock(BasicTestBlockchain chain)
    {
        Hash256 parentHash = chain.BlockTree.Head!.Hash!;
        TaskCompletionSource<Block> updated = new(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnPoolHeadChanged(object? sender, Block block)
        {
            if (block.ParentHash == parentHash) updated.TrySetResult(block);
        }
        chain.TxPool.TxPoolHeadChanged += OnPoolHeadChanged;
        try
        {
            Block block = await WalletBlock(chain);
            Block poolHead = await updated.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.That(poolHead.Hash, Is.EqualTo(block.Hash));
            return block;
        }
        finally
        {
            chain.TxPool.TxPoolHeadChanged -= OnPoolHeadChanged;
        }
    }
    private static JsonElement LegacyFixture()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(CompatibilityRoot, "legacy-wallet.json")));
        return document.RootElement.Clone();
    }

    private static Transaction LegacyTransaction(bool deployed)
    {
        JsonElement example = LegacyFixture().GetProperty("cases").EnumerateArray()
            .Single(item => item.GetProperty("deploy").GetBoolean() != deployed);
        byte[] raw = WalletBytes(example.GetProperty("raw").GetString()!);
        Transaction tx = Rlp.Decode<Transaction>(new Rlp(raw), RlpBehaviors.SkipTypedWrapping)!;
        Assert.That(tx.NonceKeys, Is.Null);
        Assert.That(FrameTxSigHash.ComputeValue(tx).ToString(), Is.EqualTo(example.GetProperty("digest").GetString()));
        Assert.That(Rlp.Encode(tx, RlpBehaviors.SkipTypedWrapping).Bytes, Is.EqualTo(raw));
        return tx;
    }

    [TestCase(1337ul, true, 2_000_000_000ul, true)]
    [TestCase(1337ul, true, 1_790_274_781ul, true)]
    [TestCase(1337ul, true, 1_790_274_780ul, false)]
    [TestCase(1337ul, false, 2_000_000_000ul, false)]
    [TestCase(1ul, true, 2_000_000_000ul, false)]
    public void Daisugi_compatibility_requires_explicit_chain_configuration(ulong chainId, bool enabled, ulong time, bool expected)
    {
        JsonNode genesis = JsonNode.Parse(File.ReadAllBytes(Path.Combine(CompatibilityRoot, "live-genesis-public.json")))!;
        genesis["config"]!["chainId"] = chainId;
        genesis["config"]!["daisugiLegacyFrames"] = enabled;
        genesis["config"]!["eip8288PrototypeTime"] = 2_000_000_000ul;
        ChainSpec chain = new GethGenesisLoader(new EthereumJsonSerializer()).Load(
            new MemoryStream(System.Text.Encoding.UTF8.GetBytes(genesis.ToJsonString())));
        IReleaseSpec spec = new ChainSpecBasedSpecProvider(chain, LimboLogs.Instance).GetSpec(new ForkActivation(1_000_000, time));
        Assert.That(spec.IsDaisugiLegacyFramesEnabled, Is.EqualTo(expected));
        Assert.That(FrameTxValidation.GetMaxVerifyGas(spec), Is.EqualTo(expected ? 500_000ul : 300_000ul));
        Assert.That(new ReleaseSpecDecorator(spec).IsDaisugiLegacyFramesEnabled, Is.EqualTo(expected));
        Transaction tx = LegacyTransaction(true);
        Assert.That((bool)FrameTxNonceKeysTxValidator.Instance.IsWellFormed(tx, spec),
            Is.EqualTo(!spec.IsEip8250Enabled || expected));
    }

    private static async Task<BasicTestBlockchain> CompatibilityChain(bool deployed, bool enabled = true, bool includeAa = false)
    {
        ReleaseSpec spec = DaisugiPragueSpec.Instance.Clone();
        spec.IsDaisugiLegacyFramesEnabled = enabled;
        DaisugiTestBlockchain chain = new();
        await chain.Initialize(builder => builder
            .AddSingleton<ISpecProvider>(new TestSpecProvider(spec) { ChainId = 1337, NetworkId = 1337, AllowTestChainOverride = false })
            .AddSingleton<ILeanProofVerifier>(NativeLeanProofVerifier.Instance)
            .AddSingleton(new LeanProofStore())
            .AddSingleton<IUnclesValidator, UnclesValidator>()
            .AddSingleton<ITxSealer, Nethermind.Wallet.IWallet, ITimestamper>((wallet, clock) =>
                new TxSealer(new Nethermind.Wallet.WalletTxSigner(wallet, 1337), clock))
            .AddSingleton<ITxSender, TxPoolSender>()
            .AddSingleton<ITxPoolConfig>(new TxPoolConfig { FrameTxMaxVerifyGas = 500_000 })
            .AddScoped<IGenesisPostProcessor, IWorldState, ISpecProvider>((state, provider) =>
                new Nethermind.Core.Test.Container.FunctionalGenesisPostProcessor(genesis =>
                {
                    genesis.Header.GasLimit = 30_000_000;
                    JsonElement data = WalletData();
                    foreach ((string address, string code) in new[] { ("factory", "factoryRuntime"), ("implementation", "implementationRuntime") })
                    {
                        Address target = new(data.GetProperty("config").GetProperty(address).GetString()!);
                        state.CreateAccount(target, UInt256.Zero);
                        state.InsertCode(target, WalletBytes(data.GetProperty(code).GetString()!), provider.GenesisSpec);
                    }
                    foreach (JsonElement item in data.GetProperty("fixtures").EnumerateArray())
                        state.CreateAccount(new Address(item.GetProperty("sender").GetString()!), UInt256.Parse("10000000000000000000"));
                    state.CreateAccount(DaisugiRecipient, UInt256.Zero);
                    state.InsertCode(DaisugiRecipient, Convert.FromHexString("60003560005500"), provider.GenesisSpec);

                    JsonElement old = LegacyFixture();
                    foreach ((string address, string code) in new[] { ("factory", "factoryCode"), ("implementation", "implementationCode"), ("verifierAddress", "verifierCode") })
                    {
                        Address target = new(old.GetProperty(address).GetString()!);
                        state.CreateAccount(target, UInt256.Zero);
                        state.InsertCode(target, WalletBytes(old.GetProperty(code).GetString()!), provider.GenesisSpec);
                    }
                    Address sender = new(old.GetProperty("account").GetString()!);
                    state.CreateAccount(sender, UInt256.Parse("10000000000000000000"), deployed ? 1ul : 0ul);
                    if (deployed) state.InsertCode(sender, WalletBytes(old.GetProperty("accountCode").GetString()!), provider.GenesisSpec);
                    if (includeAa)
                    {
                        using JsonDocument aa = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(CompatibilityRoot, "aa-fixture.json")));
                        foreach (JsonElement runtime in aa.RootElement.GetProperty("code").EnumerateArray())
                        {
                            Address target = new(runtime.GetProperty("address").GetString()!);
                            byte[] code = WalletBytes(runtime.GetProperty("code").GetString()!);
                            if (state.AccountExists(target))
                            {
                                Assert.That(state.GetCodeHash(target).ToString(), Is.EqualTo(Keccak.Compute(code).ToString()));
                                continue;
                            }
                            state.CreateAccount(target, UInt256.Zero);
                            state.InsertCode(target, code, provider.GenesisSpec);
                        }
                        state.CreateAccount(new Address(aa.RootElement.GetProperty("sender").GetString()!), UInt256.Parse("10000000000000000000"));
                    }
                    state.RecalculateStateRoot();
                })));
        return chain;
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task Daisugi_compatibility_mixed_block_preserves_original_sphincs_wallet(bool deployed)
    {
        using BasicTestBlockchain producer = await CompatibilityChain(deployed);
        Transaction legacy = LegacyTransaction(deployed);
        ResultWrapper<Hash256> accepted = await WalletRpc(producer).eth_sendRawTransaction(Rlp.Encode(legacy, RlpBehaviors.SkipTypedWrapping).Bytes);
        Assert.That(accepted.Result, Is.EqualTo(Result.Success), accepted.Result.Error);
        Assert.That(accepted.Data, Is.EqualTo(legacy.Hash));
        for (int index = 0; index < 2; index++)
        {
            string wrapper = WalletData().GetProperty("fixtures")[index].GetProperty("scenarios")[0].GetProperty("wrapper").GetString()!;
            ResultWrapper<Hash256[]> result = await WalletRpc(producer).eth_sendProofWrapper(WalletBytes(wrapper));
            Assert.That(result.Result, Is.EqualTo(Result.Success), result.Result.Error);
        }
        Block block = await CompatibilityBlock(producer);
        Assert.That(block.Transactions, Has.Length.EqualTo(3));
        TxReceipt[] receipts = producer.ReceiptStorage.Get(block);
        Assert.That(receipts.All(receipt => receipt.FrameReceipts!.All(frame => frame.Status == StatusCode.Success)), Is.True);
        Transaction included = block.Transactions.Single(tx => tx.NonceKeys is null);
        Assert.That(Rlp.Encode(included, RlpBehaviors.SkipTypedWrapping).Bytes,
            Is.EqualTo(Rlp.Encode(legacy, RlpBehaviors.SkipTypedWrapping).Bytes), "The original signed envelope must not be transformed");
        Assert.That(included.FrameSignatures![0].Signature.Length, Is.EqualTo(6176));
        Assert.That(block.Transactions.Where(tx => tx.NonceKeys is not null).All(tx => tx.FrameSignatures!.Length == 0), Is.True);
        Assert.That(block.Header.RecursiveStark!.StarkProof.Length, Is.GreaterThan(12));
        using (producer.MainWorldState.BeginScope(block.Header))
        {
            Assert.That(producer.MainWorldState.GetNonce(legacy.SenderAddress!), Is.EqualTo(2ul));
            Assert.That(producer.MainWorldState.GetCodeHash(legacy.SenderAddress!).ToString(), Is.EqualTo(Keccak.Compute(WalletBytes(LegacyFixture().GetProperty("accountCode").GetString()!)).ToString()));
            Assert.That(producer.MainWorldState.GetBalance(legacy.Frames![^1].Target!), Is.EqualTo(legacy.Frames[^1].Value));
            Assert.That(KeyedNonceManager.IsNonceSetValid(producer.MainWorldState, legacy.SenderAddress!, [UInt256.Zero], legacy.Nonce), Is.False);
        }
        // Fresh receiver has no aggregate signature witnesses or trusted proof cache.
        using BasicTestBlockchain receiver = await CompatibilityChain(deployed);
        Block transported = Rlp.Decode<Block>(Rlp.Encode(block).Bytes.AsSpan())!;
        Assert.That(transported.Hash, Is.EqualTo(block.Hash));
        Assert.That(transported.Header.SlotNumber, Is.Zero);
        Assert.That(Rlp.Encode(transported).Bytes, Is.EqualTo(Rlp.Encode(block).Bytes));
        Assert.That(receiver.BlockTree.Head!.Hash, Is.EqualTo(transported.ParentHash));
        Assert.That(receiver.Container.Resolve<IBlockValidator>().ValidateSuggestedBlock(transported, receiver.BlockTree.Head.Header, out string? error), Is.True, error);
        Assert.That(receiver.BlockTree.SuggestBlock(transported, BlockTreeSuggestOptions.ForceDontSetAsMain), Is.EqualTo(AddBlockResult.Added));
        Block imported = receiver.BlockchainProcessor.Process(transported, ProcessingOptions.StoreReceipts | ProcessingOptions.ForceProcessing, NullBlockTracer.Instance)!;
        Assert.That(imported, Is.Not.Null);
        Assert.That(imported.StateRoot, Is.EqualTo(block.StateRoot));
        Assert.That(receiver.ReceiptStorage.Get(imported).Select(r => r.GasUsed), Is.EqualTo(receipts.Select(r => r.GasUsed)));
        foreach (string mutation in new[] { "missing-proof", "corrupt-proof", "nonzero-slot" })
        {
            using BasicTestBlockchain rejecting = await CompatibilityChain(deployed);
            Block invalid = Rlp.Decode<Block>(Rlp.Encode(block).Bytes.AsSpan())!;
            if (mutation == "missing-proof") invalid.Header.RecursiveStark = null;
            if (mutation == "corrupt-proof") invalid.Header.RecursiveStark!.StarkProof[^1] ^= 1;
            if (mutation == "nonzero-slot") invalid.Header.SlotNumber = 1;
            invalid.Header.Hash = invalid.Header.CalculateHash();
            Assert.That(rejecting.Container.Resolve<IBlockValidator>().ValidateSuggestedBlock(invalid,
                rejecting.BlockTree.Head!.Header, out string? rejection), Is.False, mutation);
            if (mutation == "corrupt-proof") Assert.That(rejection, Is.EqualTo(Nethermind.Core.Messages.BlockErrorMessages.InvalidRecursiveStark));
            if (mutation == "nonzero-slot") Assert.That(rejection, Is.EqualTo(Nethermind.Core.Messages.BlockErrorMessages.SlotNumberNotEnabled));
        }
        string prefix = Path.Combine(CompatibilityRoot, deployed ? "existing" : "creation");
        File.WriteAllBytes(prefix + "-mixed-block.rlp", Rlp.Encode(block).Bytes);
        File.WriteAllText(prefix + "-mixed-result.json", JsonSerializer.Serialize(new {
            deployed, blockHash = block.Hash!.ToString(), blockGas = block.GasUsed,
            proofBytes = block.Header.RecursiveStark.StarkProof.Length,
            proofSha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(block.Header.RecursiveStark.StarkProof)),
            legacyHash = legacy.Hash!.ToString(), originalEnvelopePreserved = true,
            independentlyImported = true, receipts = receipts.Select(r => new { r.GasUsed, r.StatusCode }) }));
    }

    [TestCase("signature")]
    [TestCase("value")]
    [TestCase("keyed-envelope")]
    [TestCase("no-compatibility")]
    public async Task Daisugi_compatibility_rejects_unverified_legacy_changes(string change)
    {
        using BasicTestBlockchain chain = await CompatibilityChain(true, change != "no-compatibility");
        Transaction tx = LegacyTransaction(true);
        if (change == "signature")
        {
            TxFrameSignature original = tx.FrameSignatures![0];
            byte[] bad = original.Signature.ToArray(); bad[0] ^= 1;
            tx.FrameSignatures[0] = new(original.Scheme, original.Signer, original.Msg, bad);
        }
        if (change == "keyed-envelope") tx.NonceKeys = [UInt256.Zero];
        if (change == "value")
        {
            TxFrame original = tx.Frames![^1];
            tx.Frames[^1] = new(original.Mode, original.Flags, original.Target, original.ExecutionGasLimit,
                original.StateGasLimit, original.Value + UInt256.One, original.Data);
        }
        tx.Hash = tx.CalculateHash();
        ResultWrapper<Hash256> result = await WalletRpc(chain).eth_sendRawTransaction(Rlp.Encode(tx, RlpBehaviors.SkipTypedWrapping).Bytes);
        Assert.That(result.Result, Is.Not.EqualTo(Result.Success));
        Assert.That(result.Result.Error, Does.Not.Contain("timed out").And.Not.Contain("MAX_VERIFY_GAS"));
        Assert.That(result.Result.Error, Does.Contain(change == "no-compatibility" ? "legacy nonce" : "reverted"));
        Assert.That(chain.TxPool.GetPendingTransactions(), Is.Empty);
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task Daisugi_compatibility_scalar_and_key_zero_cannot_spend_the_same_nonce(bool keyedFirst)
    {
        using JsonDocument fixtures = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(CompatibilityRoot, "nonce-fixtures.json")));
        byte[] Raw(bool keyed, int nonce) => WalletBytes(fixtures.RootElement.GetProperty("cases").EnumerateArray()
            .Single(item => item.GetProperty("keyed").GetBoolean() == keyed && item.GetProperty("nonce").GetInt32() == nonce)
            .GetProperty("raw").GetString()!);
        using BasicTestBlockchain chain = await CompatibilityChain(true);
        ResultWrapper<Hash256> first = await WalletRpc(chain).eth_sendRawTransaction(Raw(keyedFirst, 1));
        Assert.That(first.Result, Is.EqualTo(Result.Success), first.Result.Error);
        Block firstBlock = await CompatibilityBlock(chain);
        Assert.That(chain.ReceiptStorage.Get(firstBlock).Single().FrameReceipts!.All(frame => frame.Status == StatusCode.Success), Is.True);
        ResultWrapper<Hash256> replay = await WalletRpc(chain).eth_sendRawTransaction(Raw(!keyedFirst, 1));
        Assert.That(replay.Result, Is.Not.EqualTo(Result.Success));
        Assert.That(replay.Result.Error, Does.Contain("nonce").IgnoreCase);
        ResultWrapper<Hash256> next = await WalletRpc(chain).eth_sendRawTransaction(Raw(!keyedFirst, 2));
        Assert.That(next.Result, Is.EqualTo(Result.Success), next.Result.Error);
        Block secondBlock = await CompatibilityBlock(chain);
        Assert.That(chain.ReceiptStorage.Get(secondBlock).Single().FrameReceipts!.All(frame => frame.Status == StatusCode.Success), Is.True);
        using (chain.MainWorldState.BeginScope(secondBlock.Header))
            Assert.That(chain.MainWorldState.GetNonce(new Address(LegacyFixture().GetProperty("account").GetString()!)), Is.EqualTo(3ul));
    }

    [Test]
    public async Task Daisugi_compatibility_executes_real_erc4337_entry_point_with_both_frame_paths()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(CompatibilityRoot, "aa-fixture.json")));
        JsonElement aa = document.RootElement;
        using BasicTestBlockchain chain = await CompatibilityChain(true, includeAa: true);
        Transaction bundle = Build.A.Transaction.WithType(TxType.EIP1559).WithChainId(1337)
            .WithNonce(0).WithValue(0).WithTo(new Address(aa.GetProperty("entryPoint").GetString()!))
            .WithData(WalletBytes(aa.GetProperty("calldata").GetString()!)).WithGasLimit(5_000_000)
            .WithMaxFeePerGas(2_000_000_000).WithMaxPriorityFeePerGas(1_000_000_000)
            .SignedAndResolved(TestItem.PrivateKeyB).TestObject;
        Transaction legacy = LegacyTransaction(true);
        byte[] raw = Rlp.Encode(legacy, RlpBehaviors.SkipTypedWrapping).Bytes;
        ResultWrapper<Hash256> native = await WalletRpc(chain).eth_sendRawTransaction(raw);
        bool retried = native.Result != Result.Success;
        if (retried)
        {
            Assert.That(native.Result.Error, Does.Contain("simulation timed out"));
            // Preserve the admission deadline. Retry the identical bytes once on a new head,
            // since the client caches rejected hashes for the current head.
            Assert.That((await CompatibilityBlock(chain)).Transactions, Is.Empty);
            native = await WalletRpc(chain).eth_sendRawTransaction(raw);
        }
        Assert.That(native.Result, Is.EqualTo(Result.Success), native.Result.Error);
        using (chain.MainWorldState.BeginScope(chain.BlockTree.Head!.Header))
        {
            CallOutputTracer trace = new();
            chain.TxProcessor.CallAndRestore(bundle,
                new BlockExecutionContext(chain.BlockTree.Head.Header, chain.SpecProvider.GetSpec(chain.BlockTree.Head.Header)), trace);
            File.WriteAllText(Path.Combine(CompatibilityRoot, "erc4337-call.json"), JsonSerializer.Serialize(new {
                trace.Error, returned = Convert.ToHexStringLower(trace.ReturnValue ?? []) }));
            Assert.That(trace.Error, Is.Null, Convert.ToHexStringLower(trace.ReturnValue ?? []));
        }
        Assert.That(chain.TxPool.SubmitTx(bundle, TxHandlingOptions.None), Is.EqualTo(AcceptTxResult.Accepted));
        string wrapper = WalletData().GetProperty("fixtures")[0].GetProperty("scenarios")[0].GetProperty("wrapper").GetString()!;
        ResultWrapper<Hash256[]> aggregated = await WalletRpc(chain).eth_sendProofWrapper(WalletBytes(wrapper));
        Assert.That(aggregated.Result, Is.EqualTo(Result.Success), aggregated.Result.Error);
        Block block = await CompatibilityBlock(chain);
        Assert.That(block.Transactions, Has.Length.EqualTo(3));
        TxReceipt receipt = chain.ReceiptStorage.Get(block).Single(item => item.TxHash == bundle.Hash);
        Assert.That(receipt.StatusCode, Is.EqualTo(StatusCode.Success));
        LogEntry userOperation = receipt.Logs!.Single(log => log.Topics.Length != 0 && log.Topics[0].ToString() == aa.GetProperty("eventTopic").GetString());
        Assert.That(userOperation.Topics[1].ToString(), Is.EqualTo(aa.GetProperty("userOpHash").GetString()));
        Assert.That(new UInt256(userOperation.Data.AsSpan(32, 32), isBigEndian: true), Is.EqualTo(UInt256.One), "EntryPoint must report successful UserOperation execution");
        File.WriteAllText(Path.Combine(CompatibilityRoot, "erc4337-mixed-result.json"), JsonSerializer.Serialize(new {
            userOpHash = aa.GetProperty("userOpHash").GetString(), success = true, bundleGas = receipt.GasUsed,
            blockHash = block.Hash!.ToString(), proofBytes = block.Header.RecursiveStark!.StarkProof.Length,
            reusedPublishedSignature = true, syntheticState = true, liveSubmission = false,
            legacyAdmissionRetriedAfterNewHead = retried, simulationTimeoutMs = 250 }));
    }
}
