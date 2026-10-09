"""Assemble isolated transport checks from pinned Nethermind tests and reviewed fragments."""
import argparse
import hashlib
from pathlib import Path

BASE_SHA256 = "d64211c3418ce1d1b8e8defb545a345118c417d9ec2ca86dfcc06cb75bf4fd12"


def replace_once(content: str, old: str, new: str) -> str:
    if content.count(old) != 1:
        raise ValueError(f"Expected one source anchor: {old!r}")
    return content.replace(old, new)


def assemble(base: Path, frames: Path) -> str:
    original = base.read_bytes()
    if hashlib.sha256(original).hexdigest() != BASE_SHA256:
        raise ValueError("Unexpected NativeBlockProductionTests source; use the pinned original file")
    content = original.decode("utf-8")
    anchor = "    private sealed class CountingNativeVerifier : ILeanProofVerifier"
    content = replace_once(content, "using Autofac;", "using Autofac;\nusing Nethermind.Evm;\nusing Nethermind.Evm.State;\nusing Nethermind.Evm.TransactionProcessing;")
    fragments = [frames / "authorization/NativeAuthorizationChecks.cs.fragment",
                 frames / "wallet/NativeWalletChecks.cs.fragment",
                 frames / "consensus/NativeTransportChecks.cs.fragment"]
    content = replace_once(content, anchor, "".join(p.read_text(encoding="utf-8") for p in fragments) + anchor)
    content = replace_once(content, "class NativeBlockProductionTests", "class DaisugiPragueTransportTests")
    content = content.replace("Eip8288Prototype.Instance", "DaisugiPragueSpec.Instance")
    # Bypass the upstream harness's automatic EIP-3607 suppression, not validation.
    content = content.replace("new SingleReleaseSpecProvider(DaisugiPragueSpec.Instance, 1337, 1337)",
        "new TestSpecProvider(DaisugiPragueSpec.Instance) { ChainId = 1337, NetworkId = 1337, AllowTestChainOverride = false }")
    content = replace_once(content, "header.BlobGasUsed = 0;",
        "header.Difficulty = UInt256.Zero;\n            header.TotalDifficulty = parent.TotalDifficulty;\n"
        "            header.IsPostMerge = true;\n            header.BlobGasUsed = 0;")
    content = replace_once(content, "PrevRandao = Keccak.Zero, SlotNumber = (parent.SlotNumber ?? 0) + 1", "PrevRandao = Keccak.Zero")
    anchor = '            System.IO.File.WriteAllBytes(prefix + "-proof.bin", block.Header.RecursiveStark!.StarkProof);'
    content = replace_once(content, anchor, anchor + "\n            ExportEnginePayload(block, prefix);")
    # PoS blocks have equal total difficulty. Process them and select the head explicitly
    # in this in-memory harness; this does not exercise beacon fork choice.
    content = content.replace("Nethermind.Consensus.Processing.ProcessingOptions.StoreReceipts,",
        "Nethermind.Consensus.Processing.ProcessingOptions.StoreReceipts | Nethermind.Consensus.Processing.ProcessingOptions.ForceProcessing,")
    content = replace_once(content, "        return block;",
        "        Assert.That(chain.BlockTree.TryUpdateMainChain(block.Header, wereProcessed: true, forceUpdateHeadBlock: true, preloadedBlocks: [block]), Is.True);\n"
        "        Assert.That(chain.BlockTree.Head!.Hash, Is.EqualTo(block.Hash));\n        return block;")
    content = content.replace("        return chain;",
        "        Assert.That(chain.SpecProvider.GetSpec(chain.BlockTree.Head!.Header).IsEip3607Enabled, Is.True);\n        return chain;")
    return content


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path, help="Unmodified NativeBlockProductionTests.cs at the pinned revision")
    parser.add_argument("output", type=Path, help="New test source in a private Nethermind checkout")
    parser.add_argument("--frames", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    content = assemble(args.base, args.frames.resolve())
    if args.output.exists() and args.output.read_text(encoding="utf-8") != content:
        raise SystemExit("Output differs; review it and select a new output path")
    args.output.write_text(content, encoding="utf-8", newline="\n")
    print("Prepared isolated Prague transport tests; no running node or chain was changed.")
