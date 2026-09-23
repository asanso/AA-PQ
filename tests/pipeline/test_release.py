import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import portal_release as release
spec = importlib.util.spec_from_file_location("prepare_release", SCRIPTS / "prepare-portal-release.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

COMMIT = "a" * 40
PREVIOUS = "b" * 40
TREE = "c" * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.archive = self.root / "portal.tar.gz"
        self.files = {name: b"{}" for name in release.REQUIRED}
        self.files["frontend/public/index.html"] = b"<h1>Daisugi</h1>"

    def tearDown(self):
        self.temp.cleanup()

    def package(self):
        return release.create_archive(self.files, COMMIT, TREE, self.archive)

    def checksum(self):
        return release.digest(self.archive.read_bytes())

    def config(self):
        return {"environment": "staging", "root": str(self.root),
                "node": "/usr/bin/node", "npm_cli": "/usr/lib/node_modules/npm/bin/npm-cli.js",
                "services": ["daisugi-staging-portal.service"],
                "health_checks": [{"kind": "release", "url": "http://127.0.0.1:3004/release.json"}]}

    def previous(self):
        previous = self.root / "releases" / PREVIOUS
        previous.mkdir(parents=True)
        release.set_current(self.root, previous)
        return previous

    @unittest.skipIf(sys.platform == "win32", "Deployment configuration is Linux-specific")
    def test_protected_host_configuration(self):
        config = self.config()
        config["node"] = sys.executable
        config["npm_cli"] = sys.executable
        path = self.root / "staging.json"
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        self.assertEqual(release.read_config(path, "staging"), config)
        with self.assertRaisesRegex(ValueError, "environment"):
            release.read_config(path, "production")
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "mode 0600"):
            release.read_config(path, "staging")

    @unittest.skipIf(sys.platform == "win32", "Deployment configuration is Linux-specific")
    def test_external_health_endpoint_is_rejected(self):
        config = self.config()
        config["node"] = sys.executable
        config["npm_cli"] = sys.executable
        config["health_checks"][0]["url"] = "https://example.com/release.json"
        path = self.root / "staging.json"
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "loopback"):
            release.read_config(path, "staging")

    def test_wrong_running_revision_fails_health(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = json.dumps({"commit": PREVIOUS}).encode()
        with patch.object(release.urllib.request, "urlopen", return_value=response), patch.object(release.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "health checks failed"):
                release.health(self.config(), COMMIT)

    @unittest.skipIf(sys.platform == "win32", "Atomic directory symlink replacement requires Linux")
    def test_failed_rollback_reports_operator_intervention(self):
        self.previous()
        target = self.root / "releases" / COMMIT
        target.mkdir()
        with patch.object(release, "restart"), patch.object(release, "health", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "operator intervention"):
                release.activate(self.config(), target)

    def test_archive_round_trip_preserves_source_and_identity(self):
        manifest = self.package()
        actual, files = release.inspect_archive(self.archive, COMMIT, self.checksum())
        self.assertEqual(actual, manifest)
        self.assertEqual(files["frontend/public/index.html"], self.files["frontend/public/index.html"])
        self.assertEqual(json.loads(files["frontend/public/release.json"])["commit"], COMMIT)

    def test_rejects_secret_dependency_and_traversal_paths(self):
        for path in ("frontend/.env", "frontend/.env.production", "frontend/node_modules/a.js",
                     "../server.mjs", "/frontend/server.mjs", "frontend/../server.mjs",
                     "frontend\\server.mjs", "frontend//server.mjs", ".preview/preview.env"):
            with self.subTest(path=path):
                self.assertFalse(release.allowed_path(path))

    def test_rejects_incomplete_runtime(self):
        self.files.pop("frontend/server.mjs")
        with self.assertRaisesRegex(ValueError, "Required runtime"):
            self.package()

    def test_rejects_checksum_and_commit_mismatch(self):
        self.package()
        with self.assertRaisesRegex(ValueError, "checksum"):
            release.inspect_archive(self.archive, COMMIT, "0" * 64)
        with self.assertRaisesRegex(ValueError, "identity"):
            release.inspect_archive(self.archive, PREVIOUS, self.checksum())

    def test_rejects_symbolic_links_inside_archive(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            link = tarfile.TarInfo("frontend/server.mjs")
            link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(link)
        with self.assertRaisesRegex(ValueError, "regular files"):
            release.inspect_archive(self.archive, COMMIT, self.checksum())

    def test_rejects_duplicate_archive_entries(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            for _ in range(2):
                entry = tarfile.TarInfo("frontend/server.mjs")
                entry.size = 2
                archive.addfile(entry, io.BytesIO(b"{}"))
        with self.assertRaisesRegex(ValueError, "unique"):
            release.inspect_archive(self.archive, COMMIT, self.checksum())

    def test_rejects_content_not_matching_manifest(self):
        self.package()
        with tarfile.open(self.archive, "r:gz") as archive:
            members = [(item, archive.extractfile(item).read()) for item in archive]
        with tarfile.open(self.archive, "w:gz") as archive:
            for item, data in members:
                if item.name == "frontend/server.mjs":
                    data = b"modified"
                item.size = len(data)
                archive.addfile(item, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "manifest"):
            release.inspect_archive(self.archive, COMMIT, self.checksum())

    def test_packaging_reads_git_blobs_not_uncommitted_files(self):
        listing = b"\0".join(b"100644 blob " + name.encode().hex().encode() + b"\t" + name.encode()
                             for name in self.files) + b"\0"
        blobs = {name.encode().hex(): data for name, data in self.files.items()}
        def git(args):
            if args == ["git", "rev-parse", "HEAD"]:
                return COMMIT.encode()
            if args == ["git", "rev-parse", "HEAD^{tree}"]:
                return TREE.encode()
            if args[1] == "ls-tree":
                return listing
            if args[1:3] == ["cat-file", "blob"]:
                return blobs[args[3]]
            raise AssertionError(args)
        with patch.object(release.subprocess, "check_output", side_effect=git):
            release.package_commit(self.archive)
        _, actual = release.inspect_archive(self.archive, COMMIT, self.checksum())
        self.assertEqual(actual["frontend/server.mjs"], self.files["frontend/server.mjs"])

    @unittest.skipIf(sys.platform == "win32", "Atomic directory symlink replacement requires Linux")
    def test_successful_activation_changes_current_after_checks(self):
        self.previous()
        target = self.root / "releases" / COMMIT
        target.mkdir()
        with patch.object(release, "restart") as restart, patch.object(release, "health") as health:
            release.activate(self.config(), target)
        self.assertEqual((self.root / "current").resolve(), target)
        restart.assert_called_once()
        health.assert_called_once_with(self.config(), COMMIT)

    @unittest.skipIf(sys.platform == "win32", "Atomic directory symlink replacement requires Linux")
    def test_failed_health_check_restores_and_checks_previous_release(self):
        previous = self.previous()
        target = self.root / "releases" / COMMIT
        target.mkdir()
        with patch.object(release, "restart") as restart, patch.object(
                release, "health", side_effect=[RuntimeError("unhealthy"), None]) as health:
            with self.assertRaisesRegex(RuntimeError, "previous state restored"):
                release.activate(self.config(), target)
        self.assertEqual((self.root / "current").resolve(), previous)
        self.assertEqual(restart.call_count, 2)
        self.assertEqual(health.call_args.args[1], PREVIOUS)

    def test_failed_first_deployment_stops_service_and_removes_current(self):
        target = self.root / "releases" / COMMIT
        target.mkdir(parents=True)
        with patch.object(release, "restart"), patch.object(release, "health", side_effect=ValueError("failed")), \
                patch.object(release.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "previous state restored"):
                release.activate(self.config(), target)
        self.assertFalse((self.root / "current").is_symlink())
        self.assertEqual(run.call_args.args[0][:3], ["systemctl", "--user", "stop"])

    def test_refuses_current_link_outside_release_directory(self):
        (self.root / "current").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "outside"):
            release.previous_release(self.root)

    @unittest.skipIf(sys.platform == "win32", "Installation uses Linux file locks")
    def test_dependency_failure_keeps_previous_release(self):
        previous = self.previous()
        self.package()
        with patch.object(release.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "npm")):
            with self.assertRaises(subprocess.CalledProcessError):
                release.install(self.config(), self.archive, COMMIT, self.checksum())
        self.assertEqual((self.root / "current").resolve(), previous)
        self.assertFalse((self.root / "releases" / COMMIT).exists())
        self.assertFalse(list((self.root / "releases").glob(".prepare-*")))

    @unittest.skipIf(sys.platform == "win32", "Installation uses Linux file locks")
    def test_install_prepares_dependencies_before_activation(self):
        self.package()
        with patch.object(release.subprocess, "run") as run, patch.object(release, "activate") as activate:
            release.install(self.config(), self.archive, COMMIT, self.checksum())
        self.assertEqual(run.call_count, 2)
        self.assertTrue(all("--ignore-scripts" in call.args[0] for call in run.call_args_list))
        activate.assert_called_once_with(self.config(), self.root / "releases" / COMMIT)

    @unittest.skipIf(sys.platform == "win32", "Installation uses Linux file locks")
    def test_modified_existing_release_is_rejected(self):
        self.package()
        with patch.object(release.subprocess, "run"), patch.object(release, "activate"):
            release.install(self.config(), self.archive, COMMIT, self.checksum())
        (self.root / "releases" / COMMIT / "frontend/server.mjs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "modified"):
            release.install(self.config(), self.archive, COMMIT, self.checksum())


class PromotionTests(unittest.TestCase):
    def env(self, **updates):
        return {"GITHUB_SHA": COMMIT, "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/main", "EXPECTED_MAIN_SHA": COMMIT,
                "REVIEWED_STAGING_SHA": PREVIOUS, "PRODUCTION_DEPLOY_ENABLED": "true", **updates}

    def git(self, args):
        return (COMMIT if args[-1] == "HEAD" else TREE).encode()

    def api(self, path):
        return [{"id": 7}] if path.startswith("/deployments?") else [{"state": "success"}]

    def test_staging_push_can_prepare_release(self):
        env = self.env(GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/staging")
        self.assertEqual(prepare.validate_release(env, self.api, self.git), "staging")

    def test_main_push_cannot_deploy(self):
        with self.assertRaisesRegex(ValueError, "Only staging"):
            prepare.validate_release(self.env(GITHUB_EVENT_NAME="push"), self.api, self.git)

    def test_manual_production_requires_exact_sha_and_staging_success(self):
        self.assertEqual(prepare.validate_release(self.env(), self.api, self.git), "production")
        with self.assertRaisesRegex(ValueError, "requested main"):
            prepare.validate_release(self.env(EXPECTED_MAIN_SHA=PREVIOUS), self.api, self.git)

    def test_manual_deployment_from_dev_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "manually from main"):
            prepare.validate_release(self.env(GITHUB_REF="refs/heads/dev"), self.api, self.git)

    def test_disabled_production_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not been enabled"):
            prepare.validate_release(self.env(PRODUCTION_DEPLOY_ENABLED="false"), self.api, self.git)

    def test_new_source_after_staging_is_rejected(self):
        def git(args):
            if args[-1] == PREVIOUS + "^{tree}":
                return ("d" * 40).encode()
            return self.git(args)
        with self.assertRaisesRegex(ValueError, "differs"):
            prepare.validate_release(self.env(), self.api, git)

    def test_missing_successful_staging_deployment_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no successful staging"):
            prepare.validate_release(self.env(), lambda path: [], self.git)

    def test_failed_staging_deployment_is_rejected(self):
        def api(path):
            return [{"id": 7}] if path.startswith("/deployments?") else [{"state": "failure"}]
        with self.assertRaisesRegex(ValueError, "no successful staging"):
            prepare.validate_release(self.env(), api, self.git)

    def test_wrong_checkout_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Checkout"):
            prepare.validate_release(self.env(), self.api, lambda args: PREVIOUS.encode())


if __name__ == "__main__":
    unittest.main()
