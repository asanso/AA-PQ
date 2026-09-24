#!/usr/bin/env bash
set -euo pipefail
AA_NETHERMIND_REF=c9ad4b5dc3b6db053c3a770ead8130594eb51152
AA_PATCH_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AA_BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aa-pq-nethermind-build.XXXXXX")
AA_IMAGE=${AA_IMAGE:-aa-pq-nethermind:frames-c9ad4b5-aa1}
printf 'Retaining build source in %s\n' "$AA_BUILD_DIR"
git -C "$AA_BUILD_DIR" init
git -C "$AA_BUILD_DIR" remote add origin https://github.com/NethermindEth/nethermind.git
git -C "$AA_BUILD_DIR" fetch --depth 1 origin "$AA_NETHERMIND_REF"
git -C "$AA_BUILD_DIR" checkout --detach FETCH_HEAD
test "$(git -C "$AA_BUILD_DIR" rev-parse HEAD)" = "$AA_NETHERMIND_REF"
git -C "$AA_BUILD_DIR" apply --check "$AA_PATCH_DIR/tohex-prefix.patch"
git -C "$AA_BUILD_DIR" apply "$AA_PATCH_DIR/tohex-prefix.patch"
docker build --build-arg COMMIT_HASH="$AA_NETHERMIND_REF" \
  --build-arg VERSION=frames-c9ad4b5-aa1 -t "$AA_IMAGE" "$AA_BUILD_DIR"
docker image inspect "$AA_IMAGE" --format '{{.Id}} {{.Architecture}}'
