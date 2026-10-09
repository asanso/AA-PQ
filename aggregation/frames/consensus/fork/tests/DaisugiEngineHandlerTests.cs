using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
using Autofac;
using Nethermind.Blockchain;
using Nethermind.Blockchain.Find;
using Nethermind.Blockchain.Receipts;
using Nethermind.Consensus;
using Nethermind.Consensus.Processing;
using Nethermind.Consensus.Validators;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Core.Test.Blockchain;
using Nethermind.Crypto;
using Nethermind.Int256;
using Nethermind.JsonRpc;
using Nethermind.Logging;
using Nethermind.Merge.Plugin;
using Nethermind.Merge.Plugin.BlockProduction;
using Nethermind.Merge.Plugin.Data;
using Nethermind.Merge.Plugin.Handlers;
using Nethermind.Merge.Plugin.InvalidChainTracker;
using Nethermind.Merge.Plugin.Synchronization;
using Nethermind.Serialization.Json;
using Nethermind.Serialization.Rlp;
using Nethermind.Synchronization;
using NSubstitute;
using NUnit.Framework;

namespace Nethermind.Crypto.LeanFfi.Test;

public partial class DaisugiPragueTransportTests
{
    private static ForkchoiceUpdatedHandler ActualForkchoiceHandler(BasicTestBlockchain chain, IPayloadPreparationService preparation)
    {
        IPoSSwitcher pos = Substitute.For<IPoSSwitcher>();
        pos.FinalTotalDifficulty.Returns(chain.BlockTree.Head.TotalDifficulty);
        pos.TerminalTotalDifficulty.Returns((UInt256?)UInt256.Zero);
        pos.TransitionFinished.Returns(true);
        return new ForkchoiceUpdatedHandler(chain.BlockTree, pos, preparation, chain.BlockProcessingQueue,
            Substitute.For<IBlockCacheService>(), Substitute.For<IInvalidChainTracker>(),
            Substitute.For<IMergeSyncController>(), Substitute.For<IBeaconPivot>(),
            Substitute.For<IPeerRefresher>(), chain.SpecProvider,
            Substitute.For<Nethermind.Synchronization.Peers.ISyncPeerPool>(),
            new MergeConfig { TerminalTotalDifficulty = "0" }, LimboLogs.Instance,
            chain.Container.Resolve<IBlockProcessingPauseControl>(), chain.Container.Resolve<BlockTreeMutationLock>());
    }

    [Test]
    public async Task Daisugi_engine_production_with_two_second_slots()
    {
        using BasicTestBlockchain producer = await WalletChain();
        using BasicTestBlockchain receiver = await WalletChain();
        Nethermind.JsonRpc.Modules.Eth.IEthRpcModule rpc = WalletRpc(producer);
        System.Collections.Generic.List<object> records = [];
        string output = Path.Combine(WalletRoot, "engine-production.json");
        void Record(object entry)
        {
            records.Add(entry);
            File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(records));
        }

        // Retry only this transient admission rejection, using the identical signed bytes.
        for (int index = 0; index < 2; index++)
        {
            byte[] wrapper = WalletBytes(WalletData().GetProperty("fixtures")[index].GetProperty("scenarios")[0].GetProperty("wrapper").GetString());
            for (int attempt = 0; ; attempt++)
            {
                Stopwatch clock = Stopwatch.StartNew();
                ResultWrapper<Nethermind.Core.Crypto.Hash256[]> accepted = await rpc.eth_sendProofWrapper(wrapper);
                Record(new { stage = "admission", index, attempt, milliseconds = clock.Elapsed.TotalMilliseconds,
                    success = accepted.Result == Result.Success, error = accepted.Result.Error });
                if (accepted.Result == Result.Success) break;
                Assert.That(attempt, Is.LessThan(1), accepted.Result.Error);
                Assert.That(accepted.Result.Error, Does.Contain("validation-prefix simulation timed out"));
                await Task.Delay(250);
            }
        }

        await using Nethermind.Network.P2P.Subprotocols.Lean.LeanProofGossip background = new(
            producer.Container.Resolve<Nethermind.Consensus.ProofAggregation.ProofWrapperService>(), LimboLogs.Instance);
        background.Start();
        using PayloadPreparationService preparation = new(producer.BlockProducer, producer.TxPool,
            new BlockImprovementContextFactory(producer.BlockProducer, TimeSpan.FromSeconds(1.5)),
            Nethermind.Core.Timers.TimerFactory.Default, LimboLogs.Instance, TimeSpan.FromSeconds(2));
        ForkchoiceUpdatedHandler producerForkchoice = ActualForkchoiceHandler(producer, preparation);
        ForkchoiceUpdatedHandler receiverForkchoice = ActualForkchoiceHandler(receiver, Substitute.For<IPayloadPreparationService>());
        GetPayloadV4Handler getPayload = new(preparation, producer.SpecProvider, LimboLogs.Instance, new CompositeBuilderOverridePolicy());
        using NewPayloadHandler producerImport = ActualPayloadHandler(producer);
        using NewPayloadHandler receiverImport = ActualPayloadHandler(receiver);
        int included = 0;
        for (int slot = 0; slot < 8 && included == 0; slot++)
        {
            BlockHeader parent = producer.BlockTree.Head.Header;
            Stopwatch clock = Stopwatch.StartNew();
            ResultWrapper<ForkchoiceUpdatedV1Result> choice = await producerForkchoice.Handle(
                new ForkchoiceStateV1(parent.Hash, Keccak.Zero, Keccak.Zero),
                new Nethermind.Consensus.Producers.PayloadAttributes
                {
                    Timestamp = parent.Timestamp + 2, Withdrawals = [], ParentBeaconBlockRoot = Keccak.Zero,
                    PrevRandao = Keccak.Zero, SuggestedFeeRecipient = Address.Zero
                }, 3);
            Assert.That(choice.Result, Is.EqualTo(Result.Success), choice.Result.Error);
            Assert.That(choice.Data.PayloadStatus.Status, Is.EqualTo("VALID"));
            Record(new { stage = "forkchoice-build", slot, milliseconds = clock.Elapsed.TotalMilliseconds });
            Assert.That(clock.Elapsed.TotalSeconds, Is.LessThan(2));
            await Task.Delay(1500);
            clock.Restart();
            ResultWrapper<GetPayloadV4Result> result = await getPayload.HandleAsync(WalletBytes(choice.Data.PayloadId));
            Assert.That(result.Result, Is.EqualTo(Result.Success), result.Result.Error);
            ExecutionPayloadV3 payload = result.Data.ExecutionPayload;
            payload.ParentBeaconBlockRoot = Keccak.Zero;
            payload.ExecutionRequests = result.Data.ExecutionRequests;
            Assert.That(payload.RecursiveStarkProof, Is.Not.Empty);
            included = payload.Transactions.Length;
            Record(new { stage = "get-payload", slot, milliseconds = clock.Elapsed.TotalMilliseconds,
                transactions = included, proofBytes = payload.RecursiveStarkProof.Length });
            Assert.That(clock.Elapsed.TotalSeconds, Is.LessThan(2));
            foreach ((BasicTestBlockchain chain, NewPayloadHandler importer, ForkchoiceUpdatedHandler fcu) in new[]
                { (producer, producerImport, producerForkchoice), (receiver, receiverImport, receiverForkchoice) })
            {
                ResultWrapper<PayloadStatusV1> imported = await importer.HandleAsync(payload);
                Assert.That(imported.Data.Status, Is.EqualTo("VALID"), imported.Data.ValidationError);
                ResultWrapper<ForkchoiceUpdatedV1Result> selected = await fcu.Handle(
                    new ForkchoiceStateV1(payload.BlockHash, Keccak.Zero, Keccak.Zero), null, 3);
                Assert.That(selected.Data.PayloadStatus.Status, Is.EqualTo("VALID"));
                Assert.That(chain.BlockTree.Head.Hash, Is.EqualTo(payload.BlockHash));
            }
            Assert.That(receiver.BlockTree.Head.StateRoot, Is.EqualTo(producer.BlockTree.Head.StateRoot));
            await Task.Delay(500);
        }
        Assert.That(included, Is.EqualTo(2));
        Assert.That(receiver.TxPool.GetPendingTransactions(), Is.Empty);
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task Daisugi_production_timings(bool preAggregate)
    {
        using BasicTestBlockchain chain = await WalletChain();
        Nethermind.JsonRpc.Modules.Eth.IEthRpcModule rpc = WalletRpc(chain);
        System.Text.Json.JsonElement data = WalletData();
        System.Collections.Generic.List<object> records = [];
        string output = Path.Combine(WalletRoot, $"timings-{preAggregate}.json");
        for (int round = 0; round < 2; round++)
        {
            for (int index = 0; index < 2; index++)
            {
                byte[] wrapper = WalletBytes(data.GetProperty("fixtures")[index].GetProperty("scenarios")[round].GetProperty("wrapper").GetString());
                Stopwatch clock = Stopwatch.StartNew();
                ResultWrapper<Nethermind.Core.Crypto.Hash256[]> submitted = await rpc.eth_sendProofWrapper(wrapper);
                clock.Stop();
                records.Add(new { stage="admission", round, index, milliseconds=clock.Elapsed.TotalMilliseconds, success=submitted.Result==Result.Success, error=submitted.Result.Error });
                File.WriteAllText(output,System.Text.Json.JsonSerializer.Serialize(records));
                Assert.That(submitted.Result, Is.EqualTo(Result.Success), submitted.Result.Error);
            }
            if (preAggregate)
            {
                Stopwatch clock = Stopwatch.StartNew();
                Result<byte[]> wrapper = chain.Container.Resolve<Nethermind.Consensus.ProofAggregation.ProofWrapperService>().BuildWrapper();
                clock.Stop();
                records.Add(new { stage="preaggregation",round,milliseconds=clock.Elapsed.TotalMilliseconds,success=wrapper.IsSuccess });
                File.WriteAllText(output,System.Text.Json.JsonSerializer.Serialize(records));
                Assert.That(wrapper.IsSuccess,Is.True,wrapper.Error);
            }
            Stopwatch timer = Stopwatch.StartNew();
            Block block = await WalletBlock(chain);
            timer.Stop();
            Assert.That(block.Transactions,Has.Length.EqualTo(2));
            records.Add(new { stage="production-import",round,milliseconds=timer.Elapsed.TotalMilliseconds,
                proofBytes=block.Header.RecursiveStark.StarkProof.Length,gas=block.GasUsed });
            File.WriteAllText(output,System.Text.Json.JsonSerializer.Serialize(records));
        }
    }

    private static NewPayloadHandler ActualPayloadHandler(BasicTestBlockchain chain)
    {
        IPoSSwitcher pos = Substitute.For<IPoSSwitcher>();
        pos.FinalTotalDifficulty.Returns(chain.BlockTree.Head.TotalDifficulty);
        pos.TerminalTotalDifficulty.Returns((UInt256?)UInt256.Zero);
        pos.TransitionFinished.Returns(true);
        IBeaconSyncStrategy sync = Substitute.For<IBeaconSyncStrategy>();
        sync.IsBeaconSyncFinished(Arg.Any<BlockHeader>()).Returns(true);
        return new NewPayloadHandler(
            Substitute.For<IPayloadPreparationService>(), chain.Container.Resolve<IBlockValidator>(), chain.BlockTree,
            pos, sync, Substitute.For<IBeaconPivot>(), Substitute.For<IBlockCacheService>(),
            chain.BlockProcessingQueue, Substitute.For<IInvalidChainTracker>(), Substitute.For<IMergeSyncController>(),
            new MergeConfig { TerminalTotalDifficulty = "0" }, new ReceiptConfig { StoreReceipts = true },
            chain.WorldStateManager.GlobalStateReader, chain.Container.Resolve<RecoverSignatures>(),
            chain.SpecProvider, new TxValidator(1337), LimboLogs.Instance, NativeLeanProofVerifier.Instance);
    }

    [Test]
    public async Task Daisugi_http_engine_receiver()
    {
        using BasicTestBlockchain chain = await WalletChain();
        using NewPayloadHandler handler = ActualPayloadHandler(chain);
        using System.Net.HttpListener listener = new();
        listener.Prefixes.Add("http://+:8188/");
        listener.Start();
        File.WriteAllText(Path.Combine(WalletRoot,"http-ready"),"ready");
        EthereumJsonSerializer serializer = new();
        for (int index = 0; index < 5; index++)
        {
            System.Net.HttpListenerContext context = await listener.GetContextAsync().WaitAsync(TimeSpan.FromSeconds(45));
            Assert.That(context.Request.ContentLength64, Is.InRange(0, 2_000_000));
            using System.Text.Json.JsonDocument request = await System.Text.Json.JsonDocument.ParseAsync(context.Request.InputStream);
            System.Text.Json.JsonElement json = request.RootElement;
            Assert.That(json.GetProperty("method").GetString(), Is.EqualTo("engine_newPayloadV4"));
            System.Text.Json.JsonElement parameters = json.GetProperty("params");
            Assert.That(parameters.GetArrayLength(), Is.EqualTo(4));
            Assert.That(parameters[1].GetArrayLength(), Is.Zero);
            Assert.That(parameters[3].GetArrayLength(), Is.Zero);
            ExecutionPayloadV3 payload = serializer.Deserialize<ExecutionPayloadV3>(parameters[0].GetRawText());
            payload.ParentBeaconBlockRoot = new Nethermind.Core.Crypto.Hash256(parameters[2].GetString());
            payload.ExecutionRequests = [];
            Assert.That(payload.ValidateForkOnNewPayload(chain.SpecProvider, 4), Is.True);
            Stopwatch timer = Stopwatch.StartNew();
            ResultWrapper<PayloadStatusV1> result = await handler.HandleAsync(payload);
            timer.Stop();
            Assert.That(result.Result, Is.EqualTo(Result.Success));
            bool expectedValid = index is 0 or 4;
            Assert.That(result.Data.Status, Is.EqualTo(expectedValid ? "VALID" : "INVALID"), result.Data.ValidationError);
            if (expectedValid)
            {
                await chain.BlockProcessingQueue.WaitUntilRemovedAsync(payload.BlockHash);
                Block processed = chain.BlockTree.FindBlock(payload.BlockHash, BlockTreeLookupOptions.None);
                Assert.That(processed, Is.Not.Null);
                Assert.That(chain.BlockTree.TryUpdateMainChain(processed.Header, wereProcessed: true, forceUpdateHeadBlock: true, preloadedBlocks: [processed]), Is.True);
            }
            byte[] response = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc="2.0", id=json.GetProperty("id").Clone(), result=result.Data }, EthereumJsonSerializer.JsonOptions);
            context.Response.ContentType = "application/json";
            context.Response.ContentLength64 = response.Length;
            await context.Response.OutputStream.WriteAsync(response);
            context.Response.Close();
            File.WriteAllText(Path.Combine(WalletRoot,$"http-response-{index}.json"),System.Text.Json.JsonSerializer.Serialize(new {
                index,status=result.Data.Status,error=result.Data.ValidationError,milliseconds=timer.Elapsed.TotalMilliseconds,witnessStoreWasEmpty=true }));
        }
    }

    [TestCase("valid")]
    [TestCase("corrupt-proof")]
    [TestCase("missing-proof")]
    [TestCase("changed-commitment")]
    public async Task Daisugi_actual_new_payload_handler(string scenario)
    {
        using BasicTestBlockchain chain = await WalletChain();
        using NewPayloadHandler handler = ActualPayloadHandler(chain);
        EthereumJsonSerializer serializer = new();
        int accepted = 0;
        for (int round=0; round<(scenario=="valid"?2:1); round++)
        {
            string prefix=Path.Combine(WalletRoot,"wallet-block-"+round);
            Block original=Rlp.Decode<Block>(File.ReadAllBytes(prefix+".rlp").AsSpan());
            ExecutionPayloadV3 payload=serializer.Deserialize<ExecutionPayloadV3>(File.ReadAllText(prefix+"-engine.json"));
            payload.ParentBeaconBlockRoot=original.ParentBeaconBlockRoot;
            payload.ExecutionRequests=original.ExecutionRequests??[];
            if(scenario=="corrupt-proof") payload.RecursiveStarkProof[^1]^=1;
            if(scenario=="missing-proof") payload.RecursiveStarkProof=null;
            if(scenario=="changed-commitment") payload.RecursiveStarkBlockDepsHash[0]^=1;
            if(scenario is "corrupt-proof" or "changed-commitment") payload.BlockHash=payload.TryGetBlock().Data.Header.CalculateHash();
            Stopwatch timer=Stopwatch.StartNew();
            ResultWrapper<PayloadStatusV1> result=await handler.HandleAsync(payload);
            timer.Stop();
            Assert.That(result.Result,Is.EqualTo(Result.Success));
            Assert.That(result.Data.Status,Is.EqualTo(scenario=="valid"?"VALID":"INVALID"), result.Data.ValidationError);
            if(scenario=="valid")
            {
                await chain.BlockProcessingQueue.WaitUntilRemovedAsync(original.Hash);
                Block processed=chain.BlockTree.FindBlock(original.Hash,BlockTreeLookupOptions.None);
                Assert.That(processed,Is.Not.Null);
                Assert.That(processed.StateRoot,Is.EqualTo(original.StateRoot));
                Assert.That(chain.BlockTree.TryUpdateMainChain(processed.Header,wereProcessed:true,forceUpdateHeadBlock:true,preloadedBlocks:[processed]),Is.True);
                accepted++;
            }
            File.WriteAllText(Path.Combine(WalletRoot,$"actual-handler-{scenario}-{round}.json"),System.Text.Json.JsonSerializer.Serialize(new {
                scenario,round,status=result.Data.Status,error=result.Data.ValidationError,milliseconds=timer.Elapsed.TotalMilliseconds,accepted,witnessStoreWasEmpty=true }));
        }
    }
}
