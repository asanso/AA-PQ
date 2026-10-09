// SPDX-License-Identifier: LGPL-3.0-only

using System;
using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Nethermind.Core;

namespace Nethermind.Crypto;

/// <summary>Owns one persistent prover process. The verifier never uses its mutable arena.</summary>
public sealed class AdaptiveProofWorker : IDisposable
{
    private readonly object _gate = new();
    private Process? _process;
    private bool _disposed;
    private const int TimeoutSeconds = 120;

    public byte[] Prove(ReadOnlySpan<byte> hash, ReadOnlySpan<byte> key, byte[] input)
    {
        if (hash.Length != 32 || key.Length != 32 || input.Length > Eip8288Constants.MaxAggregationInputBytes)
            throw new ArgumentException("Invalid prover request bounds.");
        byte[] request = new byte[68 + input.Length];
        BinaryPrimitives.WriteInt32LittleEndian(request, input.Length);
        hash.CopyTo(request.AsSpan(4));
        key.CopyTo(request.AsSpan(36));
        input.CopyTo(request, 68);
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            Process process = Start();
            try
            {
                using CancellationTokenSource deadline = new(TimeSpan.FromSeconds(TimeoutSeconds));
                return Exchange(process, request, deadline.Token).GetAwaiter().GetResult();
            }
            catch
            {
                Stop();
                throw;
            }
        }
    }

    private Process Start()
    {
        if (_process is { HasExited: false }) return _process;
        Stop();
        string path = Path.Combine(AppContext.BaseDirectory, "daisugi-lean-worker");
        if (!File.Exists(path)) throw new InvalidOperationException("The isolated adaptive prover is not installed.");
        ProcessStartInfo start = new(path)
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
            // Native diagnostics use stderr. Only the bounded binary protocol uses stdout.
            RedirectStandardError = false, CreateNoWindow = true
        };
        start.Environment["LEANVM_NUM_THREADS"] = "14";
        start.Environment["RAYON_NUM_THREADS"] = "14";
        start.Environment["DAISUGI_BENCH_LEAF_SIZE"] = "40";
        start.Environment["DAISUGI_BENCH_ARENA"] = "1";
        start.Environment["DAISUGI_BENCH_DENSE_BASIS"] = "1";
        start.Environment["DAISUGI_BENCH_RETAIN_CODEWORD"] = "1";
        start.Environment["DAISUGI_BENCH_HUGE_PAGES"] = "1";
        return _process = Process.Start(start) ?? throw new InvalidOperationException("Cannot start the adaptive prover.");
    }

    private static async Task<byte[]> Exchange(Process process, byte[] request, CancellationToken cancellation)
    {
        Stream output = process.StandardOutput.BaseStream;
        await process.StandardInput.BaseStream.WriteAsync(request, cancellation).ConfigureAwait(false);
        await process.StandardInput.BaseStream.FlushAsync(cancellation).ConfigureAwait(false);
        byte[] header = new byte[5];
        await output.ReadExactlyAsync(header, cancellation).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(1));
        if (header[0] != 1 || length is <= 0 or > Eip8288Constants.MaxProofBytes)
            throw new InvalidOperationException("The adaptive prover rejected the request or returned an invalid response.");
        byte[] proof = new byte[length];
        await output.ReadExactlyAsync(proof, cancellation).ConfigureAwait(false);
        return proof;
    }

    private void Stop()
    {
        if (_process is null) return;
        try { if (!_process.HasExited) { _process.Kill(entireProcessTree: true); _process.WaitForExit(5000); } }
        finally { _process.Dispose(); _process = null; }
    }

    public void Dispose()
    {
        lock (_gate) { if (_disposed) return; _disposed = true; Stop(); }
    }
}
