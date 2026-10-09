using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipelines;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Nethermind.Blockchain;
using Nethermind.Blockchain.Blocks;
using Nethermind.Blockchain.BlockAccessLists;
using Nethermind.Core;
using Nethermind.Core.Crypto;
using Nethermind.Core.Specs;
using Nethermind.Core.Validation;
using Nethermind.Core.Test.Builders;
using Nethermind.JsonRpc;
using Nethermind.Logging;
using Nethermind.Merge.Plugin.Data;
using Nethermind.Merge.Plugin.Handlers;
using Nethermind.Merge.Plugin.SszRest;
using Nethermind.Serialization.Json;
using Nethermind.Serialization.Rlp;
using Nethermind.Consensus.Validators;
using Nethermind.Int256;
using Nethermind.Specs;
using Nethermind.Specs.ChainSpecStyle;
using NSubstitute;
using NUnit.Framework;
using ValidationResult = Nethermind.Core.ValidationResult;

namespace Nethermind.Crypto.LeanFfi.Test;

[NonParallelizable]
public class DaisugiPayloadBodyTransportTests
{
    [Test]
    public void Live_genesis_preserves_history_and_schedules_only_the_selected_prototype()
    {
        string root = Environment.GetEnvironmentVariable("DAISUGI_TRANSPORT_FIXTURES")!;
        byte[] original = File.ReadAllBytes(Path.Combine(root, "live-genesis-public.json"));
        GethGenesisLoader loader = new(new EthereumJsonSerializer());
        ChainSpec baseline = loader.Load(new MemoryStream(original));
        const ulong activation = 2_000_000_000; // Offline fixture, never an activation proposal.
        System.Text.Json.Nodes.JsonNode changed = System.Text.Json.Nodes.JsonNode.Parse(original)!;
        changed["config"]!["eip8288PrototypeTime"] = activation;
        ChainSpec candidate = loader.Load(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(changed.ToJsonString())));
        ChainSpecBasedSpecProvider before = new(baseline, LimboLogs.Instance);
        ChainSpecBasedSpecProvider after = new(candidate, LimboLogs.Instance);
        Assert.That(candidate.ChainId, Is.EqualTo(1337));
        Assert.That(candidate.Parameters.Eip8141TransitionTimestamp, Is.EqualTo(baseline.Parameters.Eip8141TransitionTimestamp));
        Assert.That(candidate.Parameters.Eip8288TransitionTimestamp, Is.EqualTo(activation));
        Assert.That(candidate.Parameters.Eip8250TransitionTimestamp, Is.EqualTo(activation));
        Assert.That(candidate.Parameters.Eip8272TransitionTimestamp, Is.EqualTo(activation));
        Assert.That(candidate.Parameters.Eip7906TransitionTimestamp, Is.EqualTo(activation));
        foreach (ulong time in new ulong[] { 1789235743, 1790274780, 1790274781, activation - 1 })
        {
            IReleaseSpec oldSpec = before.GetSpec(new ForkActivation(1_000_000, time));
            IReleaseSpec newSpec = after.GetSpec(new ForkActivation(1_000_000, time));
            foreach (System.Reflection.PropertyInfo property in typeof(IReleaseSpec).GetProperties())
                if (property.PropertyType == typeof(bool) && property.Name.StartsWith("IsEip"))
                    Assert.That(property.GetValue(newSpec), Is.EqualTo(property.GetValue(oldSpec)), property.Name);
        }
        IReleaseSpec active = after.GetSpec(new ForkActivation(1_000_000, activation));
        Assert.That(active.IsEip8141Enabled && active.IsEip8288Enabled && active.IsEip8250Enabled
            && active.IsEip8272Enabled && active.IsEip7906Enabled, Is.True);
        Assert.That(active.IsEip7928Enabled || active.IsEip8037Enabled || active.IsEip7825Enabled, Is.False);
    }

    [Test]
    public void Historical_scalar_frame_keeps_hash_and_digest_but_is_gated_after_keyed_nonce_activation()
    {
        using JsonDocument fixture = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Environment.GetEnvironmentVariable("DAISUGI_TRANSPORT_FIXTURES")!, "historical-frame.json")));
        byte[] raw = Convert.FromHexString(fixture.RootElement.GetProperty("raw").GetString()![2..]);
        Transaction tx = Rlp.Decode<Transaction>(new Rlp(raw), RlpBehaviors.SkipTypedWrapping);
        Assert.That(tx.Hash!.ToString(), Is.EqualTo(fixture.RootElement.GetProperty("hash").GetString()));
        Assert.That(FrameTxSigHash.ComputeValue(tx).ToString(), Is.EqualTo(fixture.RootElement.GetProperty("digest").GetString()));
        Assert.That(Rlp.Encode(tx, RlpBehaviors.SkipTypedWrapping).Bytes, Is.EqualTo(raw));
        Assert.That(tx.NonceKeys, Is.Null);
        Assert.That(FrameTxNonceKeysTxValidator.Instance.IsWellFormed(tx, new ReleaseSpec { IsEip8250Enabled = false }), Is.EqualTo(ValidationResult.Success));
        Assert.That(FrameTxNonceKeysTxValidator.Instance.IsWellFormed(tx, new ReleaseSpec { IsEip8250Enabled = true }), Is.Not.EqualTo(ValidationResult.Success));
        tx.NonceKeys = [UInt256.Zero];
        Assert.That(FrameTxNonceKeysTxValidator.Instance.IsWellFormed(tx, new ReleaseSpec { IsEip8250Enabled = true }), Is.EqualTo(ValidationResult.Success));
        Assert.That(FrameTxSigHash.ComputeValue(tx).ToString(), Is.Not.EqualTo(fixture.RootElement.GetProperty("digest").GetString()));
    }

    [TestCase("wallet-block-0")]
    [TestCase("wallet-block-1")]
    [TestCase("empty-block")]
    public async Task Persisted_block_body_preserves_complete_proof(string name)
    {
        string root = Environment.GetEnvironmentVariable("DAISUGI_TRANSPORT_FIXTURES")!;
        byte[] rlp = File.ReadAllBytes(Path.Combine(root, name + ".rlp"));
        Block block = Rlp.Decode<Block>(new Rlp(rlp));
        IBlockTree tree = Substitute.For<IBlockTree>();
        IBlockStore store = Substitute.For<IBlockStore>();
        tree.FindHeader(block.Hash!, Arg.Any<BlockTreeLookupOptions>(), Arg.Any<ulong?>()).Returns(block.Header);
        store.GetRlp(block.Number, block.Hash!).Returns(rlp);
        ResultWrapper<IReadOnlyList<ExecutionPayloadBodyV1Result>> result = new GetPayloadBodiesByHashV1Handler(tree, store, LimboLogs.Instance).Handle([block.Hash!]);
        Assert.That(result.Result, Is.EqualTo(Result.Success));
        ExecutionPayloadBodyV1Result body = result.Data[0]!;
        Assert.That(body.RecursiveStarkProof, Is.EqualTo(block.Header.RecursiveStark!.StarkProof));
        Assert.That(body.RecursiveStarkBlockDepsHash, Is.EqualTo(block.Header.RecursiveStark.BlockDepsHash.Bytes.ToArray()));
        byte[] direct = await Stream((IStreamableResult)result.Data);
        using JsonDocument actual = JsonDocument.Parse(direct);
        byte[] plain = JsonSerializer.SerializeToUtf8Bytes(result.Data, EthereumJsonSerializer.JsonOptions);
        Assert.That(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(direct),System.Text.Json.Nodes.JsonNode.Parse(plain)), Is.True);
        File.WriteAllBytes(Path.Combine(Environment.GetEnvironmentVariable("DAISUGI_TRANSPORT_OUTPUT")!,name+"-body.json"),direct);
        Assert.Throws<NotSupportedException>(() => SszCodec.EncodePayloadBodiesV1Response(result.Data,new ArrayBufferWriter<byte>()));
        IBlockAccessListStore accessLists = Substitute.For<IBlockAccessListStore>();
        ResultWrapper<IReadOnlyList<ExecutionPayloadBodyV2Result>> v2 = new GetPayloadBodiesByHashV2Handler(tree, LimboLogs.Instance, accessLists, store).Handle([block.Hash!]);
        byte[] v2Direct = await Stream((IStreamableResult)v2.Data);
        byte[] v2Plain = JsonSerializer.SerializeToUtf8Bytes(v2.Data, EthereumJsonSerializer.JsonOptions);
        Assert.That(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(v2Direct), System.Text.Json.Nodes.JsonNode.Parse(v2Plain)), Is.True);
        Assert.That(v2.Data[0]!.RecursiveStarkProof, Is.EqualTo(body.RecursiveStarkProof));
        Assert.Throws<NotSupportedException>(() => SszCodec.EncodePayloadBodiesV2Response(v2.Data, new ArrayBufferWriter<byte>()));
    }

    [Test]
    public async Task Historical_body_omits_proof_fields_and_keeps_ssz_support()
    {
        ExecutionPayloadBodyV1Result[] data = [new([],[])];
        byte[] direct = await Stream(new PayloadBodiesV1DirectResponse(data));
        using JsonDocument json = JsonDocument.Parse(direct);
        Assert.That(json.RootElement[0].TryGetProperty("recursiveStarkProof",out _),Is.False);
        Assert.That(json.RootElement[0].TryGetProperty("recursiveStarkBlockDepsHash",out _),Is.False);
        Assert.DoesNotThrow(() => SszCodec.EncodePayloadBodiesV1Response(data,new ArrayBufferWriter<byte>()));
    }

    [TestCase(12)]
    [TestCase(65537)]
    public async Task Materialized_body_stream_matches_json_serializer(int length)
    {
        ExecutionPayloadBodyV1Result body = new([],[]) {
            RecursiveStarkProof = new byte[length], RecursiveStarkBlockDepsHash = new byte[32] };
        byte[] direct = await Stream(new PayloadBodiesV1DirectResponse([body]));
        byte[] plain = JsonSerializer.SerializeToUtf8Bytes(new[]{body},EthereumJsonSerializer.JsonOptions);
        Assert.That(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(direct),System.Text.Json.Nodes.JsonNode.Parse(plain)),Is.True);
    }

    private static async Task<byte[]> Stream(IStreamableResult result)
    {
        using MemoryStream stream = new();
        PipeWriter writer = PipeWriter.Create(stream,new StreamPipeWriterOptions(leaveOpen:true));
        await result.WriteToAsync(writer,CancellationToken.None);
        await writer.FlushAsync();await writer.CompleteAsync();return stream.ToArray();
    }
}
