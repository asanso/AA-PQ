"""Prepare an offline activation proposal; never install configuration or contact a node."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re


def proposal(genesis: dict, beacon_spec: dict, genesis_time: int, epoch: int,
             version: str, current_epoch: int, *, preserve_native_wallet: bool = False) -> dict:
    if genesis.get("config", {}).get("chainId") != 1337:
        raise ValueError("Expected the existing Daisugi chain ID 1337")
    if not re.fullmatch(r"0x[0-9a-fA-F]{8}", version) or version == "0x00000000":
        raise ValueError("Select an explicit, nonzero four-byte fork version")
    if version.lower() in {str(v).lower() for k, v in beacon_spec.items() if k.endswith("FORK_VERSION")}:
        raise ValueError("Fork version conflicts with the existing schedule")
    if epoch <= current_epoch or genesis_time < 0:
        raise ValueError("The activation epoch must be in the future")
    disabled = (None, "18446744073709551615", 18446744073709551615)
    if any(beacon_spec.get(name) not in disabled for name in ("FULU_FORK_EPOCH", "GLOAS_FORK_EPOCH", "DAISUGI_FORK_EPOCH")):
        raise ValueError("An incompatible or existing custom fork is scheduled")
    if int(beacon_spec.get("ELECTRA_FORK_EPOCH", -1)) != 0:
        raise ValueError("Expected the inspected Electra-from-genesis configuration")
    if int(beacon_spec.get("SECONDS_PER_SLOT", -1)) != 2 or int(beacon_spec.get("SLOTS_PER_EPOCH", -1)) != 32:
        raise ValueError("Unexpected slot or epoch duration")
    timestamp = genesis_time + epoch * 32 * 2
    prior = genesis["config"].get("eip8141PrototypeTime")
    if not isinstance(prior, int) or timestamp <= prior:
        raise ValueError("The existing frame activation must precede aggregation")
    if genesis["config"].get("eip8288PrototypeTime") is not None:
        raise ValueError("An aggregation activation already exists")
    if any(genesis["config"].get(name) is not None for name in ("osakaTime", "amsterdamTime", "bogotaTime")):
        raise ValueError("This candidate only supports the reviewed Prague-based schedule")
    execution = copy.deepcopy(genesis)
    execution["config"]["eip8288PrototypeTime"] = timestamp
    if preserve_native_wallet:
        execution["config"]["daisugiLegacyFrames"] = True
    beacon = copy.deepcopy(beacon_spec)
    beacon["DAISUGI_FORK_EPOCH"] = str(epoch)
    beacon["DAISUGI_FORK_VERSION"] = version.lower()
    beacon["MAX_PAYLOAD_SIZE"] = str(20 * 1024 * 1024)
    return {"executionGenesis": execution, "beaconConfig": beacon, "activationTimestamp": timestamp,
            "activationEpoch": epoch, "forkVersion": version.lower(), "installed": False,
            "requiresPatchedPrototypeLabel": True,
            "legacyFrameCompatibility": bool(execution["config"].get("daisugiLegacyFrames", False)),
            "requiredFrameTxMaxVerifyGas": 500000 if execution["config"].get("daisugiLegacyFrames") else None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("execution_genesis", type=Path)
    parser.add_argument("beacon_spec", type=Path, help="Complete beacon config as a JSON object")
    parser.add_argument("output", type=Path, help="New private proposal directory")
    parser.add_argument("--genesis-time", required=True, type=int)
    parser.add_argument("--epoch", required=True, type=int)
    parser.add_argument("--current-epoch", required=True, type=int)
    parser.add_argument("--version", required=True)
    parser.add_argument("--preserve-native-wallet", action="store_true",
                        help="Explicitly propose the Daisugi scalar-frame and 500,000-gas admission compatibility profile")
    args = parser.parse_args()
    source = args.execution_genesis.read_bytes()
    beacon_source = args.beacon_spec.read_bytes()
    result = proposal(json.loads(source), json.loads(beacon_source), args.genesis_time,
                      args.epoch, args.version, args.current_epoch,
                      preserve_native_wallet=args.preserve_native_wallet)
    if args.output.exists():
        raise SystemExit("Output already exists; preserve it and choose a new directory")
    args.output.mkdir(parents=True)
    for field, name in [("executionGenesis", "genesis-proposal.json"), ("beaconConfig", "beacon-config-proposal.json")]:
        (args.output / name).write_text(json.dumps(result.pop(field), indent=2) + "\n", encoding="utf-8")
    result["inputSha256"] = {"execution": hashlib.sha256(source).hexdigest(),
                             "beacon": hashlib.sha256(beacon_source).hexdigest()}
    (args.output / "proposal.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("Prepared an offline proposal. No configuration was installed or activated.")
