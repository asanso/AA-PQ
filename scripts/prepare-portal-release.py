#!/usr/bin/env python3
"""Validate a staging or manually requested production release in GitHub Actions."""

import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request
from portal_release import SHA, digest, package_commit, require


def github(path):
    request = urllib.request.Request(
        os.environ["GITHUB_API_URL"] + "/repos/" + os.environ["GITHUB_REPOSITORY"] + path,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json", "User-Agent": "Daisugi-release"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def validate_release(env, api=github, git=subprocess.check_output):
    revision = env["GITHUB_SHA"]
    require(SHA.fullmatch(revision), "Invalid release commit")
    require(git(["git", "rev-parse", "HEAD"]).decode().strip() == revision,
            "Checkout does not match the tested commit")
    if env["GITHUB_EVENT_NAME"] == "push":
        require(env["GITHUB_REF"] == "refs/heads/staging", "Only staging pushes can deploy automatically")
        return "staging"
    require(env["GITHUB_EVENT_NAME"] == "workflow_dispatch" and env["GITHUB_REF"] == "refs/heads/main",
            "Production deployment must be started manually from main")
    require(env.get("PRODUCTION_DEPLOY_ENABLED") == "true", "Production deployment has not been enabled")
    require(env.get("EXPECTED_MAIN_SHA") == revision, "The requested main commit does not match this run")
    reviewed = env.get("REVIEWED_STAGING_SHA", "")
    require(SHA.fullmatch(reviewed), "Enter the full reviewed staging commit SHA")
    main_tree = git(["git", "rev-parse", revision + "^{tree}"]).decode().strip()
    staging_tree = git(["git", "rev-parse", reviewed + "^{tree}"]).decode().strip()
    require(main_tree == staging_tree, "Main differs from the reviewed staging source")
    deployments = api("/deployments?" + urllib.parse.urlencode(
        {"sha": reviewed, "environment": "staging", "per_page": 100}))
    for deployment in deployments:
        statuses = api("/deployments/" + str(int(deployment["id"])) + "/statuses?per_page=1")
        if statuses and statuses[0].get("state") == "success":
            return "production"
    raise ValueError("The reviewed commit has no successful staging deployment")


def main():
    environment = validate_release(os.environ)
    output = Path("dist/portal.tar.gz")
    manifest = package_commit(output)
    checksum = digest(output.read_bytes())
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("environment=" + environment + "\ncommit=" + manifest["commit"] + "\nchecksum=" + checksum + "\n")


if __name__ == "__main__":
    main()
