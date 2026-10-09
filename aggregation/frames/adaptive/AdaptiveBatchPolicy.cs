// SPDX-License-Identifier: LGPL-3.0-only

using System;

namespace Nethermind.Consensus.ProofAggregation;

/// <summary>Schedules bounded proof jobs using observed service time and a block clock.</summary>
public sealed class AdaptiveBatchPolicy
{
    public const int MaxClaims = 40;
    private const double SlotSeconds = 2;
    private const double FormationSeconds = 0.5;
    private const double MarginSeconds = 0.15;
    private double _secondsPerClaim = 0.05;
    private double? _target;
    private double _oldest = double.NaN;
    private double _lastTarget = double.NegativeInfinity;

    public double EstimatedSeconds(int claims) => 0.10 + _secondsPerClaim * claims;

    /// <summary>Observation time is monotonic; slot phase is derived from the actual head.</summary>
    public bool Ready(double now, int claims, double nextSlot)
    {
        if (!double.IsFinite(now) || !double.IsFinite(nextSlot) || claims < 0 || claims > MaxClaims)
            throw new ArgumentOutOfRangeException(nameof(claims));
        if (claims == 0) { Reset(); return false; }
        if (double.IsNaN(_oldest)) _oldest = now;
        double estimate = EstimatedSeconds(claims);
        if (_target is null)
        {
            double earliest = now + estimate + MarginSeconds;
            double target = nextSlot;
            if (target <= earliest) target += (Math.Floor((earliest - target) / SlotSeconds) + 1) * SlotSeconds;
            _target = Math.Max(target, _lastTarget + SlotSeconds);
        }
        return claims == MaxClaims || now >= Math.Max(_oldest + FormationSeconds, _target.Value - estimate - MarginSeconds);
    }

    public void Completed(double now, int claims, double seconds)
    {
        if (claims is < 1 or > MaxClaims || !double.IsFinite(seconds) || seconds < 0 || !double.IsFinite(now))
            throw new ArgumentOutOfRangeException(nameof(seconds));
        _secondsPerClaim = Math.Clamp(0.8 * _secondsPerClaim + 0.2 * Math.Max(0.005, (seconds - 0.10) / claims), 0.005, 0.20);
        // A missed target moves the next attempt forward; it does not assert inclusion.
        _lastTarget = Math.Max(_target ?? now, now);
        Reset();
    }

    public void Reset() { _target = null; _oldest = double.NaN; }
}
