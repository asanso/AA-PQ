using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

// Standalone client-language binding test; this does not process blocks.
internal static class Program
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int Verify([In] byte[] proof, nuint proofLength, [In] byte[] expected, nuint expectedLength);

    private static int Main(string[] args)
    {
        if (args.Length != 3) throw new ArgumentException("Expected library, proof and independently reconstructed claims.");
        nint library = NativeLibrary.Load(args[0]);
        try
        {
            Verify verify = Marshal.GetDelegateForFunctionPointer<Verify>(NativeLibrary.GetExport(library, "case7_verify"));
            byte[] proof = File.ReadAllBytes(args[1]);
            byte[] expected = File.ReadAllBytes(args[2]);
            var results = new List<object>();
            void Check(string name, byte[] candidate, byte[] claims, bool success)
            {
                var watch = Stopwatch.StartNew();
                int status = verify(candidate, (nuint)candidate.Length, claims, (nuint)claims.Length);
                watch.Stop();
                bool passed = success ? status == 0 : status == 1 || status == 3;
                results.Add(new { name, status, passed, milliseconds = watch.Elapsed.TotalMilliseconds });
                if (!passed) throw new InvalidOperationException($"Unexpected verifier status for {name}: {status}");
            }
            Check("Four-account recursive proof with independently reconstructed frame digests, cold", proof, expected, true);
            Check("Same recursive proof, warm", proof, expected, true);
            byte[] corrupted = (byte[])proof.Clone(); corrupted[^1] ^= 1;
            Check("Corrupted proof rejected", corrupted, expected, false);
            Check("Truncated proof rejected", proof[..^16], expected, false);
            JsonNode changed = JsonNode.Parse(expected)!;
            string message = changed["claims"]![0]!["message"]!.GetValue<string>();
            changed["claims"]![0]!["message"] = "0x" + (message[2] == '0' ? "1" : "0") + message[3..];
            Check("Different transaction digest rejected", proof, JsonSerializer.SerializeToUtf8Bytes(changed), false);
            changed = JsonNode.Parse(expected)!;
            changed["claims"]!.AsArray().RemoveAt(0);
            Check("Missing account claim rejected", proof, JsonSerializer.SerializeToUtf8Bytes(changed), false);
            Check("Empty proof rejected", [], expected, false);
            Console.WriteLine(JsonSerializer.Serialize(new { checks = results, passed = results.Count,
                scope = "Standalone .NET to Rust binding using a real recursive proof; no block import or network activation." }));
            return 0;
        }
        finally { NativeLibrary.Free(library); }
    }
}
