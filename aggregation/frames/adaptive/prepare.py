"""Generate a reviewable overlay against the pinned, already patched client source.

This tool only reads the supplied source and writes the package's overlay. It
does not update a checkout, compile, publish, configure or activate a client.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PREFIX = 'src/Nethermind/'


def prepare(source, output):
    edits = {}
    def read(name):
        return edits.get(name, (source / PREFIX / name).read_text(encoding='utf-8'))
    def replace(name, old, new, count=1):
        text = read(name)
        if text.count(old) != count:
            raise ValueError(f'Unexpected anchor count: {name}: {old[:90]}')
        edits[name] = text.replace(old, new)
    def add(name, file):
        if (source / PREFIX / name).exists(): raise ValueError(f'New file already exists: {name}')
        edits[name] = (ROOT / file).read_text()

    for name, file in [
        ('Nethermind.Consensus/ProofAggregation/AdaptiveBatchPolicy.cs', 'AdaptiveBatchPolicy.cs'),
        ('Nethermind.Consensus/ProofAggregation/VersionedLeanProofVerifier.cs', 'VersionedLeanProofVerifier.cs'),
        ('Nethermind.Core/Crypto/AdaptiveProofProgram.cs', 'AdaptiveProofProgram.cs'),
        ('Nethermind.Crypto/AdaptiveProofWorker.cs', 'AdaptiveProofWorker.cs')]: add(name, file)

    interface = 'Nethermind.Core/Crypto/ILeanProofVerifier.cs'
    replace(interface, '    void EnsureAvailable();', '''    void EnsureAvailable();
    ReadOnlySpan<byte> ProductionVerificationKey => Eip8288Constants.AggregatedVk;
    int MaxDirectSignatures => 4;
    bool AdaptiveBatchingEnabled => false;
    bool VerifyKnownRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof)
        => VerifyRecursiveStark(in hash, ProductionVerificationKey, proof);
    bool VerifyBlockRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof, bool adaptiveEnabled)
        => VerifyRecursiveStark(in hash, Eip8288Constants.AggregatedVk, proof);''')
    for cls in ['ProductionProofCache', 'InclusionListProofVerifier']:
        name = f'Nethermind.Consensus/ProofAggregation/{cls}.cs'
        anchor = '    public void EnsureAvailable() => verifier.EnsureAvailable();'
        replace(name, anchor, anchor + '''
    public ReadOnlySpan<byte> ProductionVerificationKey => verifier.ProductionVerificationKey;
    public int MaxDirectSignatures => verifier.MaxDirectSignatures;
    public bool AdaptiveBatchingEnabled => verifier.AdaptiveBatchingEnabled;
    public bool VerifyKnownRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof)
        => verifier.VerifyKnownRecursiveStark(in hash, proof);
    public bool VerifyBlockRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> proof, bool adaptiveEnabled)
        => verifier.VerifyBlockRecursiveStark(in hash, proof, adaptiveEnabled);''')

    native = 'Nethermind.Crypto/NativeLeanProofVerifier.cs'
    text = read(native).replace('NativeLeanProofVerifier', 'NativeAdaptiveProofVerifier')
    text = text.replace('"nethermind_lean"', '"nethermind_lean_adaptive"')
    text = text.replace('Eip8288Constants.AggregatedVk', 'AdaptiveProofProgram.VerificationKey')
    # Only the child process may enable the optimized arena. Verification remains in the parent.
    start = text.index('    public byte[] ProveRecursiveStark(')
    end = text.index('    internal static byte[] SerializeInput', start)
    text = text[:start] + '''    public byte[] ProveRecursiveStark(in ValueHash256 hash, ReadOnlySpan<byte> key, AggregationInput input)
        => throw new InvalidOperationException("Use the isolated adaptive prover process.");

''' + text[end:]
    edits['Nethermind.Crypto/NativeAdaptiveProofVerifier.cs'] = text.replace('internal static byte[] SerializeInput', 'public static byte[] SerializeInput')
    replace('Nethermind.Init/Modules/BlockProcessingModule.cs',
            'AddSingleton<ILeanProofVerifier, Nethermind.Crypto.NativeLeanProofVerifier>()',
            'AddSingleton<ILeanProofVerifier, VersionedLeanProofVerifier>()')

    # A separate activation timestamp defaults to absent. Historical rules remain pinned.
    replace('Nethermind.Core/Specs/IReleaseSpec.cs', '        bool IsDaisugiLegacyFramesEnabled => false;',
            '        bool IsDaisugiAdaptiveAggregationEnabled => false;\n        bool IsDaisugiLegacyFramesEnabled => false;')
    replace('Nethermind.Core/Specs/ReleaseSpecDecorator.cs', '    public virtual bool IsDaisugiLegacyFramesEnabled',
            '    public virtual bool IsDaisugiAdaptiveAggregationEnabled => spec.IsDaisugiAdaptiveAggregationEnabled;\n    public virtual bool IsDaisugiLegacyFramesEnabled')
    replace('Nethermind.Specs/ReleaseSpec.cs', '    public bool IsDaisugiLegacyFramesEnabled',
            '    public bool IsDaisugiAdaptiveAggregationEnabled { get; set; }\n    public bool IsDaisugiLegacyFramesEnabled')
    replace('Nethermind.Specs.Test/OverridableReleaseSpec.cs', '        public bool IsEip8288Enabled',
            '        public bool IsDaisugiAdaptiveAggregationEnabled => spec.IsDaisugiAdaptiveAggregationEnabled;\n        public bool IsEip8288Enabled')
    replace('Nethermind.Specs.Test/ChainSpecStyle/GethGenesisLoaderTests.cs',
            '        "Eip150Block",        // alias for TangerineWhistleBlock',
            '        "DaisugiAdaptiveAggregationTime", // Chain-specific opt-in, not an upstream named fork\n        "Eip150Block",        // alias for TangerineWhistleBlock')
    for name in ['ChainParameters.cs', 'Json/ChainSpecParamsJson.cs']:
        replace('Nethermind.Specs/ChainSpecStyle/' + name, '    public bool DaisugiLegacyFrames',
                '    public ulong? DaisugiAdaptiveAggregationTransitionTimestamp { get; set; }\n    public bool DaisugiLegacyFrames')
    replace('Nethermind.Specs/ChainSpecStyle/Json/GethGenesisConfigJson.cs', '    public bool DaisugiLegacyFrames',
            '    public ulong? DaisugiAdaptiveAggregationTime { get => GetTime(); set => SetTime(value); }\n    public bool DaisugiLegacyFrames')
    replace('Nethermind.Specs/ChainSpecStyle/GethGenesisLoader.cs', '            DaisugiLegacyFrames = config.DaisugiLegacyFrames,',
            '            DaisugiAdaptiveAggregationTransitionTimestamp = config.DaisugiAdaptiveAggregationTime,\n            DaisugiLegacyFrames = config.DaisugiLegacyFrames,')
    replace('Nethermind.Specs/ChainSpecStyle/ChainSpecLoader.cs', '            DaisugiLegacyFrames = parameters.DaisugiLegacyFrames,',
            '            DaisugiAdaptiveAggregationTransitionTimestamp = parameters.DaisugiAdaptiveAggregationTransitionTimestamp,\n            DaisugiLegacyFrames = parameters.DaisugiLegacyFrames,')
    replace('Nethermind.Specs/ChainSpecStyle/ChainSpecBasedSpecProvider.cs', '            releaseSpec.IsDaisugiLegacyFramesEnabled =',
            '''            releaseSpec.IsDaisugiAdaptiveAggregationEnabled = chainSpec.ChainId == 1337
                && releaseSpec.IsEip8288Enabled
                && (chainSpec.Parameters.DaisugiAdaptiveAggregationTransitionTimestamp ?? ulong.MaxValue) <= releaseStartTimestamp;
            releaseSpec.IsDaisugiLegacyFramesEnabled =''')

    replace('Nethermind.Consensus/Validators/BlockValidator.cs',
            '_leanProofVerifier.VerifyRecursiveStark(in computed.ValueHash256, Eip8288Constants.AggregatedVk, recursiveStark.StarkProof)',
            '_leanProofVerifier.VerifyBlockRecursiveStark(in computed.ValueHash256, recursiveStark.StarkProof, spec.IsDaisugiAdaptiveAggregationEnabled)')

    aggregator = 'Nethermind.Consensus/ProofAggregation/RecursiveStarkAggregator.cs'
    replace(aggregator, '    private const int DirectBatchSize = 4;\n', '')
    text = read(aggregator).replace('DirectBatchSize', 'verifier.MaxDirectSignatures')
    text = text.replace('Eip8288Constants.AggregatedVk', 'verifier.ProductionVerificationKey')
    edits[aggregator] = text
    # A historical exact proof can be reused; new recursive composition must use one guest.
    replace(aggregator, 'verifier.VerifyRecursiveStark(in depsHash, verifier.ProductionVerificationKey, parent.Proof.Span)',
            'verifier.VerifyKnownRecursiveStark(in depsHash, parent.Proof.Span)')

    for name in ['MempoolWrapperValidator.cs', 'ProofWrapperService.cs', 'InclusionListProofPackage.cs']:
        path = 'Nethermind.Consensus/ProofAggregation/' + name
        text = read(path)
        text = text.replace('verifier.VerifyRecursiveStark(in depsHash, Eip8288Constants.AggregatedVk, recursiveStark.StarkProof)', 'verifier.VerifyKnownRecursiveStark(in depsHash, recursiveStark.StarkProof)')
        text = text.replace('verifier.VerifyRecursiveStark(in dependencies, Eip8288Constants.AggregatedVk, proof)', 'verifier.VerifyKnownRecursiveStark(in dependencies, proof)')
        text = text.replace('leanProofVerifier.VerifyRecursiveStark(in hash, Eip8288Constants.AggregatedVk, proof)', 'leanProofVerifier.VerifyKnownRecursiveStark(in hash, proof)')
        if name == 'InclusionListProofPackage.cs': text = text.replace('Eip8288Constants.AggregatedVk', 'verifier.ProductionVerificationKey')
        edits[path] = text
    processor = 'Nethermind.Consensus/Processing/BlockProcessor.cs'
    text = read(processor).replace('Eip8288Constants.AggregatedVk', 'leanProofVerifier.ProductionVerificationKey')
    text = text.replace('leanProofVerifier.VerifyRecursiveStark(in depsHash, leanProofVerifier.ProductionVerificationKey, prepared!)', 'leanProofVerifier.VerifyKnownRecursiveStark(in depsHash, prepared!)')
    edits[processor] = text

    # Keep the existing single background worker and bounded proof store. Do not increase consensus limits.
    wrapper = 'Nethermind.Consensus/ProofAggregation/ProofWrapperService.cs'
    replace(wrapper, '    private int _rotation;', '''    private readonly AdaptiveBatchPolicy _batchPolicy = new();
    private ValueHash256? _productionProgram;
    private readonly Dictionary<ValueHash256, double> _firstSeen = [];
    public bool AdaptiveBatchingEnabled => leanProofVerifier.AdaptiveBatchingEnabled;
    public ReadOnlySpan<byte> ProductionVerificationKey => leanProofVerifier.ProductionVerificationKey;
    private int _rotation;''')
    replace(wrapper, 'Dictionary<ValueHash256, string?> _verifiedWrappers', 'Dictionary<(ValueHash256 Wrapper, ValueHash256 Program), string?> _verifiedWrappers')
    replace(wrapper, 'Queue<ValueHash256> _verifiedWrapperOrder', 'Queue<(ValueHash256 Wrapper, ValueHash256 Program)> _verifiedWrapperOrder')
    replace(wrapper, 'ValueHash256 wrapperHash = ValueKeccak.Compute(wrapper);', '''ValueHash256 admissionProgram = new(ProductionVerificationKey);
            (ValueHash256, ValueHash256) wrapperHash = (ValueKeccak.Compute(wrapper), admissionProgram);''')
    replace(wrapper, 'private void RememberVerification(ValueHash256 hash, string? error)', 'private void RememberVerification((ValueHash256, ValueHash256) hash, string? error)')
    # Only wrapper admission has a captured rule version. Inclusion-list caching
    # uses a versioned verdict key below.
    replace(wrapper, '''            else if (error is not null) return ProofWrapperAcceptance.Invalid(error);
            cancellationToken.ThrowIfCancellationRequested();''', '''            else if (error is not null) return ProofWrapperAcceptance.Invalid(error);
            cancellationToken.ThrowIfCancellationRequested();
            if (!ProductionVerificationKey.SequenceEqual(admissionProgram.Bytes))
                return ProofWrapperAcceptance.LocalFailure("Proof rules changed during admission; retry the wrapper.");''')
    replace(wrapper, '        candidates.Sort(static (a, b) => a.Hash!.Bytes.SequenceCompareTo(b.Hash!.Bytes));', '''        double now = System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency;
        ValueHash256 program = new(ProductionVerificationKey);
        if (_productionProgram != program)
        {
            _cachedWrapper = null;
            _batchPolicy.Reset();
            _firstSeen.Clear();
            _productionProgram = program;
        }
        bool adaptive = AdaptiveBatchingEnabled;
        if (adaptive)
        {
            HashSet<ValueHash256> pending = [];
            foreach (Transaction tx in candidates)
                if (tx.Hash is { } candidateHash) { pending.Add(candidateHash.ValueHash256); _firstSeen.TryAdd(candidateHash.ValueHash256, now); }
            foreach (ValueHash256 hash in new List<ValueHash256>(_firstSeen.Keys)) if (!pending.Contains(hash)) _firstSeen.Remove(hash);
            // Per-sender nonce order precedes arrival order; no batch waits for future signatures.
            candidates.Sort((a, b) => a.SenderAddress == b.SenderAddress
                ? a.Nonce.CompareTo(b.Nonce)
                : _firstSeen[a.Hash!.ValueHash256].CompareTo(_firstSeen[b.Hash!.ValueHash256]));
        }
        else candidates.Sort(static (a, b) => a.Hash!.Bytes.SequenceCompareTo(b.Hash!.Bytes));''')
    # Avoid a non-transitive mixed nonce/arrival comparator. Group arrival rank by sender instead.
    replace(wrapper, '''            candidates.Sort((a, b) => a.SenderAddress == b.SenderAddress
                ? a.Nonce.CompareTo(b.Nonce)
                : _firstSeen[a.Hash!.ValueHash256].CompareTo(_firstSeen[b.Hash!.ValueHash256]));''', '''            Dictionary<Address, double> senderArrival = [];
            foreach (Transaction tx in candidates)
                if (tx.SenderAddress is { } sender)
                    senderArrival[sender] = Math.Min(senderArrival.GetValueOrDefault(sender, double.PositiveInfinity), _firstSeen[tx.Hash!.ValueHash256]);
            candidates.Sort((a, b) =>
            {
                if (a.SenderAddress == b.SenderAddress) return a.Nonce.CompareTo(b.Nonce);
                int arrival = senderArrival.GetValueOrDefault(a.SenderAddress!, now).CompareTo(senderArrival.GetValueOrDefault(b.SenderAddress!, now));
                return arrival != 0 ? arrival : a.SenderAddress!.Bytes.SequenceCompareTo(b.SenderAddress!.Bytes);
            });''')
    replace(wrapper, 'int start = candidates.Count == 0 ? 0 :', 'int start = adaptive || candidates.Count == 0 ? 0 :')
    replace(wrapper, 'if (sphincs > Eip8288Constants.MaxLeanSigDepsPerWrapper || stark > Eip8288Constants.MaxLeanStarkDepsPerWrapper)',
            'if ((adaptive && combined.Count > AdaptiveBatchPolicy.MaxClaims) || sphincs > (adaptive ? AdaptiveBatchPolicy.MaxClaims : Eip8288Constants.MaxLeanSigDepsPerWrapper) || stark > Eip8288Constants.MaxLeanStarkDepsPerWrapper)')
    anchor = '        try\n        {\n            ValueHash256 hash = Eip8288Dependencies.ComputeDepsHash(deps);'
    replace(wrapper, anchor, '''        if (adaptive && deps.Count > 0)
        {
            double headTime = blockFinder.Head?.Timestamp ?? 0;
            double wallTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
            double nextSlot = now + (headTime + 2 - wallTime);
            if (!_batchPolicy.Ready(now, deps.Count, nextSlot)) return Result<byte[]>.Fail("Collecting the adaptive proof batch.");
        }
        long proofStarted = System.Diagnostics.Stopwatch.GetTimestamp();
        try
        {
            ValueHash256 hash = Eip8288Dependencies.ComputeDepsHash(deps);''')
    replace(wrapper, 'if (cached is not null && HasOverlap(cached.Parent.InnerDeps, covered))', 'if (!adaptive && cached is not null && HasOverlap(cached.Parent.InnerDeps, covered))')
    replace(wrapper, '''        if (skipEmpty && transactions.Count == 0)
            return Result<byte[]>.Fail("No proof-backed pending transactions.");''', '''        if (skipEmpty && transactions.Count == 0)
        {
            _batchPolicy.Reset();
            return Result<byte[]>.Fail("No proof-backed pending transactions.");
        }''')
    replace(wrapper, '            leanProofStore.AddCachedRecursive(deps, proof!);', '''            leanProofStore.AddCachedRecursive(deps, proof!);
            if (adaptive && deps.Count > 0)
                _batchPolicy.Completed(System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency,
                    deps.Count, System.Diagnostics.Stopwatch.GetElapsedTime(proofStarted).TotalSeconds);''')
    replace('Nethermind.Network/P2P/Subprotocols/Lean/LeanProofGossip.cs', 'TimeSpan.FromMilliseconds(1000)', 'TimeSpan.FromMilliseconds(wrappers.AdaptiveBatchingEnabled ? 50 : 1000)')
    replace('Nethermind.Network/P2P/Subprotocols/Lean/LeanProofGossip.cs', '                    if (!wrappers.IsEnabled) continue;',
            '                    timer.Period = TimeSpan.FromMilliseconds(wrappers.AdaptiveBatchingEnabled ? 50 : 1000);\n                    if (!wrappers.IsEnabled) continue;')
    peer = 'Nethermind.Network/P2P/Subprotocols/Lean/LeanProtocolHandler.cs'
    edits[peer] = read(peer).replace('Eip8288Constants.AggregatedVk', '_wrappers.ProductionVerificationKey')

    # Wrapper validity bounds are transport policy, not the proof/transaction claim limit.
    # A larger wrapper is accepted only once the head enables the new profile.
    validator = 'Nethermind.Consensus/ProofAggregation/MempoolWrapperValidator.cs'
    text = read(validator).replace('Eip8288Constants.MaxLeanSigDepsPerWrapper', '(verifier.AdaptiveBatchingEnabled ? AdaptiveBatchPolicy.MaxClaims : Eip8288Constants.MaxLeanSigDepsPerWrapper)')
    edits[validator] = text
    inclusion = 'Nethermind.Consensus/ProofAggregation/InclusionListProofPackage.cs'
    text = read(inclusion).replace('(ValueHash256 Dependencies, ValueHash256 Proof)', '(ValueHash256 Dependencies, ValueHash256 Proof, ValueHash256 Program)')
    text = text.replace('(ValueHash256, ValueHash256) key = (dependencies, proofHash);',
                        '(ValueHash256, ValueHash256, ValueHash256) key = (dependencies, proofHash, new ValueHash256(verifier.ProductionVerificationKey));')
    edits[inclusion] = text
    decoder = 'Nethermind.Consensus/ProofAggregation/MempoolWrapperDecoder.cs'
    edits[decoder] = read(decoder).replace('Eip8288Constants.MaxLeanSigDepsPerWrapper', 'AdaptiveBatchPolicy.MaxClaims')
    wrapper_tests = 'Nethermind.Consensus.Test/ProofAggregation/MempoolWrapperTests.cs'
    replace(wrapper_tests,
            'Enumerable.Range(0, Eip8288Constants.MaxLeanSigDepsPerWrapper + Eip8288Constants.MaxLeanStarkDepsPerWrapper + 1)',
            'Enumerable.Range(0, AdaptiveBatchPolicy.MaxClaims + Eip8288Constants.MaxLeanStarkDepsPerWrapper + 1)')
    replace(wrapper_tests, '    private static MempoolWrapper RoundTrip(MempoolWrapper wrapper)', '''    [Test]
    public void Decode_accepts_the_transport_witness_bound_without_enabling_admission()
    {
        int count = AdaptiveBatchPolicy.MaxClaims + Eip8288Constants.MaxLeanStarkDepsPerWrapper;
        MempoolWrapper wrapper = new()
        {
            Transactions = [], Deps = [], Mode = MempoolWrapper.ModeDirect,
            Proofs = Enumerable.Range(0, count).Select(_ => (byte[])[]).ToArray()
        };
        MempoolWrapper decoded = RoundTrip(wrapper);
        Assert.That(decoded.Proofs, Has.Count.EqualTo(count));
        Assert.That(MempoolWrapperValidator.Validate(decoded, Accepting, out _), Is.False);
    }

    private static MempoolWrapper RoundTrip(MempoolWrapper wrapper)''')
    # Decode bounds may be broader than active policy; the validator enforces the active bound.
    store = 'Nethermind.Core/Crypto/LeanProofStore.cs'
    replace(store, '    /// <summary>Collects direct and recursive witnesses, discarding dependencies outside the requested set.</summary>', '''    /// <summary>Returns one prepared proof covering all requested dependencies, without replacing pinned raw witnesses.</summary>
    public bool TryGetPreparedInput(IReadOnlyList<FrameDependency> dependencies, out AggregationInput input)
    {
        input = new();
        if (dependencies.Count == 0) return false;
        lock (_lock)
        {
            for (LinkedListNode<ProofRecord>? node = _recursiveCache.Last; node is not null; node = node.Previous)
            {
                ProofRecord record = node.Value;
                bool covers = true;
                foreach (FrameDependency dep in dependencies)
                    if (Array.IndexOf(record.Dependencies, dep) < 0) { covers = false; break; }
                if (!covers) continue;
                input = new() { RecursiveProofs = [record.RecursiveInput] };
                return true;
            }
        }
        return false;
    }

    /// <summary>Collects direct and recursive witnesses, discarding dependencies outside the requested set.</summary>''')

    # A ready recursive proof is the prerequisite for adaptive block selection.
    # Limit a proposal to one prepared proof group; do not start proving arbitrary
    # raw mempool signatures on the two-second proposal critical path.
    picker = 'Nethermind.Consensus/Processing/BlockProcessor.BlockProductionTransactionPicker.cs'
    replace(picker, 'leanProofStore.TryGetInput(missing, out candidateInput)',
            '(spec.IsDaisugiAdaptiveAggregationEnabled ? leanProofStore.TryGetPreparedInput(missing, out candidateInput) : leanProofStore.TryGetInput(missing, out candidateInput))')
    anchor = '                    if (!budget.TryPrepare(candidateInput, required, out AggregationInput contribution, out string? proofError))'
    replace(picker, anchor, '''                    if (spec.IsDaisugiAdaptiveAggregationEnabled && missing.Count != 0)
                    {
                        if (candidateInput.Deps.Count != 0 || candidateInput.RecursiveProofs.Count != 1)
                            return args.Set(TxAction.Skip, "Waiting for an adaptive dependency proof");
                        ValueHash256 group = candidateInput.RecursiveProofs[0].ProofHash;
                        if (producing?.AdaptiveProofGroup is { } existingGroup && existingGroup != group)
                            return args.Set(TxAction.Skip, "A different adaptive proof group is selected");
                    }
''' + anchor)
    replace('Nethermind.Consensus/Producers/BlockToProduce.cs', '        internal LeanProofBudget LeanProofBudget',
            '        internal ValueHash256? AdaptiveProofGroup { get; set; }\n        internal LeanProofBudget LeanProofBudget')
    replace('Nethermind.Consensus/Producers/BlockToProduce.cs', '                LeanProofBudget = LeanProofBudget.Clone()',
            '                AdaptiveProofGroup = AdaptiveProofGroup,\n                LeanProofBudget = LeanProofBudget.Clone()')
    replace('Nethermind.Consensus/Processing/BlockProcessor.BlockProductionTransactionsExecutor.cs',
            '                            producing.LeanProofBudget.Commit(proofInput, args.LeanDependencies);',
            '''                            producing.LeanProofBudget.Commit(proofInput, args.LeanDependencies);
                            if (proofInput.RecursiveProofs.Count == 1)
                                producing.AdaptiveProofGroup ??= proofInput.RecursiveProofs[0].ProofHash;''')

    manifest = {'schemaVersion': 1, 'activation': 'disabled', 'files': {}}
    for name, text in edits.items():
        relative = PREFIX + name
        original = source / relative
        data = text.encode()
        dest = output / 'files' / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        manifest['files'][relative] = {'before': hashlib.sha256(original.read_bytes()).hexdigest() if original.exists() else None,
                                     'after': hashlib.sha256(data).hexdigest()}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return len(edits)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(prepare(args.source, args.output))
