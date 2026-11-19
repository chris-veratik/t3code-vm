import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import project_tools as tools


class ProjectToolTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        subprocess.run(["git", "init", "-q", self.repo], check=True)

    def snapshot(self, files):
        for name, contents in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        cmd = ["git", "-C", str(self.repo)]
        subprocess.run([*cmd, "add", "."], check=True)
        subprocess.run([*cmd, "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "project"], check=True)
        return subprocess.check_output([*cmd, "rev-parse", "HEAD"], text=True).strip()

    def test_uses_selected_commit_and_nearest_project_declarations(self):
        rev = self.snapshot({".nvmrc": "20", "package.json": '{"packageManager":"pnpm@9.15.4"}',
                             "apps/web/.node-version": "22.14.0", "elsewhere/.python-version": "3.9",
                             "apps/web/pyproject.toml": '[project]\nrequires-python = ">=3.11,<3.13"\n',
                             ".devcontainer/devcontainer.json": '// test\n{"features":{"ghcr.io/devcontainers/features/github-cli:1":{},},}',
                             "apps/web/mise.toml": '[tools]\ngo = "1.24"\n[hooks]\nenter="never run"\n'})
        (self.repo / "apps/web/.node-version").write_text("99")
        result = tools.review(self.repo, rev, "apps/web")
        self.assertEqual(result, {"node":"22.14.0", "pnpm":"9.15.4", "go":"1.24",
                                  "python":">=3.11,<3.13", "github-cli":"latest"})

    def test_checkout_without_environment_skips_all_installation(self):
        rev = self.snapshot({"README.md": "nothing to install", "other/package.json": "{}"})
        with patch.object(tools, "install", side_effect=AssertionError("called installer")):
            tools.prepare(self.repo, rev, "")

    def test_java_wrappers_and_explicit_runtime_versions(self):
        rev = self.snapshot({"pom.xml":"<project><properties><java.version>21</java.version></properties></project>",
                             "mvnw":"", "rust-toolchain.toml":'[toolchain]\nchannel="stable"\n',
                             "go.mod":"module example.com/test\ngo 1.24\ntoolchain go1.24.2\n"})
        self.assertEqual(tools.review(self.repo, rev, ""), {"java":"21","rust":"stable","go":"1.24.2"})

if __name__ == "__main__":
    unittest.main()
