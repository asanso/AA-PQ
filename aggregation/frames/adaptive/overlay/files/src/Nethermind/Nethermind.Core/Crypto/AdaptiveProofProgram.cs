// SPDX-License-Identifier: LGPL-3.0-only
using System;

namespace Nethermind.Core.Crypto;

/// <summary>Versioned guest identity; signature algorithm and dependency encoding are unchanged.</summary>
public static class AdaptiveProofProgram
{
    private static readonly byte[] Key = Convert.FromHexString("2db957be2d39aa4336ae6cd1688eba49f2c6eb26e8aedddbe544f271fae1e59a");
    public static ReadOnlySpan<byte> VerificationKey => Key;
}
