using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Net;
using System.Text.Json;
using Autofac;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Test.Blockchain;
using Nethermind.Consensus.Producers;
using Nethermind.Consensus.ProofAggregation;
using Nethermind.JsonRpc;
using Nethermind.Merge.Plugin;
using Nethermind.Merge.Plugin.BlockProduction;
using Nethermind.Merge.Plugin.Data;
using Nethermind.Merge.Plugin.Handlers;
using Nethermind.Logging;
using Nethermind.Serialization.Json;
using NUnit.Framework;

namespace Nethermind.Crypto.LeanFfi.Test;

public partial class DaisugiPragueTransportTests
{
    [Test]
    public async Task Daisugi_http_beacon_engine_cycle()
    {
        using BasicTestBlockchain chain = await WalletChain();
        List<byte[]> deferred = [];
        Hash256 admissionHead = chain.BlockTree.Head!.Hash!;
        for (int index = 0; index < 2; index++)
        {
            byte[] wrapper = WalletBytes(WalletData().GetProperty("fixtures")[index].GetProperty("scenarios")[0].GetProperty("wrapper").GetString());
            ResultWrapper<Hash256[]> accepted = await WalletRpc(chain).eth_sendProofWrapper(wrapper);
            if (accepted.Result != Result.Success)
            {
                Assert.That(accepted.Result.Error, Does.Contain("validation-prefix simulation timed out"));
                deferred.Add(wrapper);
            }
        }
        await using Nethermind.Network.P2P.Subprotocols.Lean.LeanProofGossip background = new(
            chain.Container.Resolve<ProofWrapperService>(), LimboLogs.Instance);
        background.Start();
        PostMergeBlockProducer producer = new PostMergeBlockProducerFactory(chain.SpecProvider,
            Nethermind.Consensus.NullSealEngine.Instance, chain.Timestamper,
            new Nethermind.Config.BlocksConfig { MinGasPrice = 0 }, LimboLogs.Instance)
            .Create(chain.Container.Resolve<Nethermind.Consensus.Producers.IBlockProducerEnvFactory>().CreatePersistent());
        using PayloadPreparationService preparation = new(producer, chain.TxPool,
            new BlockImprovementContextFactory(producer, TimeSpan.FromSeconds(1.5)),
            Nethermind.Core.Timers.TimerFactory.Default, LimboLogs.Instance, TimeSpan.FromSeconds(2));
        ForkchoiceUpdatedHandler forkchoice = ActualForkchoiceHandler(chain, preparation);
        GetPayloadV4Handler getPayload = new(preparation, chain.SpecProvider, LimboLogs.Instance, new CompositeBuilderOverridePolicy());
        using NewPayloadHandler importer = ActualPayloadHandler(chain);
        using HttpListener listener = new();
        listener.Prefixes.Add(Environment.GetEnvironmentVariable("DAISUGI_PRIVATE_ENGINE_BIND") ?? "http://127.0.0.1:8188/");
        listener.Start();
        File.WriteAllText(Path.Combine(WalletRoot, "http-ready"), "ready");
        EthereumJsonSerializer serializer = new();
        List<object> records = [];
        HashSet<Hash256> transactions = [];
        bool finished = false;
        while (!finished)
        {
            try
            {
            HttpListenerContext context = await listener.GetContextAsync().WaitAsync(TimeSpan.FromSeconds(60));
            Assert.That(context.Request.ContentLength64, Is.InRange(-1, 4_000_000));
            using JsonDocument request = await JsonDocument.ParseAsync(context.Request.InputStream);
            JsonElement json = request.RootElement;
            JsonElement args = json.GetProperty("params");
            string method = json.GetProperty("method").GetString()!;
            File.AppendAllText(Path.Combine(WalletRoot, "requests.log"), method + Environment.NewLine);
            object result;
            switch (method)
            {
                case "test_genesis":
                    ExecutionPayloadV3 genesis = ExecutionPayloadV3.Create(new Block(chain.BlockTree.Genesis!));
                    genesis.Withdrawals = [];
                    genesis.BlobGasUsed = 0;
                    genesis.ExcessBlobGas = 0;
                    genesis.RecursiveStarkProof = Convert.FromHexString("4e4c52330000000000000000");
                    genesis.RecursiveStarkBlockDepsHash = Keccak.OfAnEmptyString.Bytes.ToArray();
                    result = genesis;
                    break;
                case "engine_exchangeCapabilities":
                    result = new[] { "engine_newPayloadV4", "engine_getPayloadV4", "engine_forkchoiceUpdatedV3",
                        "engine_getPayloadBodiesByHashV1", "engine_getPayloadBodiesByRangeV1" };
                    break;
                case "eth_syncing":
                    result = false;
                    break;
                case "eth_getBlockByNumber":
                case "eth_getBlockByHash":
                    Block current = chain.BlockTree.Head!;
                    result = new { hash = current.Hash, parentHash = current.ParentHash,
                        number = "0x" + current.Number.ToString("x"), timestamp = "0x" + current.Timestamp.ToString("x"),
                        totalDifficulty = current.TotalDifficulty ?? 0 };
                    break;
                case "engine_forkchoiceUpdatedV3":
                    ForkchoiceStateV1 state = serializer.Deserialize<ForkchoiceStateV1>(args[0].GetRawText());
                    PayloadAttributes attributes = args[1].ValueKind == JsonValueKind.Null ? null :
                        serializer.Deserialize<PayloadAttributes>(args[1].GetRawText());
                    ResultWrapper<ForkchoiceUpdatedV1Result> selected = await forkchoice.Handle(state, attributes, 3);
                    Assert.That(selected.Result, Is.EqualTo(Result.Success), selected.Result.Error);
                    result = selected.Data;
                    if (deferred.Count != 0 && chain.BlockTree.Head!.Hash != admissionHead)
                    {
                        // A timeout is cached for the current head. Retry only after canonical progress.
                        foreach (byte[] wrapper in deferred)
                        {
                            ResultWrapper<Hash256[]> retried = await WalletRpc(chain).eth_sendProofWrapper(wrapper);
                            Assert.That(retried.Result, Is.EqualTo(Result.Success), retried.Result.Error);
                        }
                        deferred.Clear();
                    }
                    break;
                case "engine_getPayloadV4":
                    ResultWrapper<GetPayloadV4Result> built = await getPayload.HandleAsync(WalletBytes(args[0].GetString()));
                    Assert.That(built.Result, Is.EqualTo(Result.Success), built.Result.Error);
                    result = built.Data;
                    break;
                case "engine_newPayloadV4":
                    ExecutionPayloadV3 payload = serializer.Deserialize<ExecutionPayloadV3>(args[0].GetRawText());
                    payload.ParentBeaconBlockRoot = new Hash256(args[2].GetString());
                    payload.ExecutionRequests = args[3].EnumerateArray().Select(item => WalletBytes(item.GetString())).ToArray();
                    Assert.That(args[1].GetArrayLength(), Is.Zero);
                    ResultWrapper<PayloadStatusV1> imported = await importer.HandleAsync(payload);
                    Assert.That(imported.Result, Is.EqualTo(Result.Success), imported.Result.Error);
                    Assert.That(imported.Data.Status, Is.EqualTo("VALID"), imported.Data.ValidationError);
                    foreach (byte[] raw in payload.Transactions) transactions.Add(Keccak.Compute(raw));
                    result = imported.Data;
                    records.Add(new { method, block = payload.BlockHash.ToString(), transactions = payload.Transactions.Length,
                        proofBytes = payload.RecursiveStarkProof!.Length, status = imported.Data.Status });
                    break;
                case "test_finish":
                    Assert.That(transactions.Count, Is.EqualTo(2));
                    result = new { transactions = transactions.Count, head = chain.BlockTree.Head!.Hash };
                    finished = true;
                    break;
                default:
                    throw new InvalidOperationException("Unexpected private test method: " + method);
            }
            records.Add(new { method });
            byte[] response = JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc = "2.0", id = json.GetProperty("id").Clone(), result }, EthereumJsonSerializer.JsonOptions);
            context.Response.ContentType = "application/json";
            context.Response.ContentLength64 = response.Length;
            await context.Response.OutputStream.WriteAsync(response);
            context.Response.Close();
            File.WriteAllText(Path.Combine(WalletRoot, "beacon-engine.json"), JsonSerializer.Serialize(records));
            }
            catch (Exception error)
            {
                File.WriteAllText(Path.Combine(WalletRoot, "failure.log"), error.ToString());
                throw;
            }
        }
    }
}
