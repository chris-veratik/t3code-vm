"""Review committed environment declarations and provision their tools inside a managed Ubuntu VM."""
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath

MISE_VERSION = "2026.11.10"
MISE_SHA = "86ef275d541c5243cd20b1c0fcd16810e5f3601113d8db09278d0608617a3833"
TOOLS = {"node", "python", "go", "rust", "ruby", "java", "maven", "gradle", "npm", "pnpm",
         "yarn", "bun", "deno", "uv", "poetry", "dotnet", "github-cli", "cmake"}
ALIASES = {"nodejs": "node", "golang": "go", "openjdk": "java", "gh": "github-cli"}
VERSIONS = {".nvmrc": "node", ".node-version": "node", ".python-version": "python",
            ".ruby-version": "ruby", ".java-version": "java", ".go-version": "go"}
LOCKS = {"pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun",
         "bun.lockb": "bun", "uv.lock": "uv", "poetry.lock": "poetry"}
STATE = Path.home() / ".local/share/t3-local-vm/project-tools"


def output(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def jsonc(text):
    # Match JSON strings first so comment markers and trailing commas inside strings survive.
    tokens = r'"(?:\\.|[^"\\])*"'
    text = re.sub(tokens + r'|//[^\n]*|/\*.*?\*/',
                  lambda m: m[0] if m[0][0] == '"' else " ", text, flags=re.S)
    return json.loads(re.sub(tokens + r'|,(?=\s*[\]}])',
                             lambda m: m[0] if m[0] != "," else "", text))


def review(repo, commit, subdir):
    git = ["git", "-C", str(repo)]
    found = {}

    def put(name, version="latest", priority=0, *, declared=False):
        name = ALIASES.get(name, name)
        if name not in TOOLS and not (declared and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)):
            return
        if not isinstance(version, str) or not version.strip():
            return
        value = version.strip()
        if value == "lts/*":
            value = "lts"
        if re.match(r"^v\d", value):
            value = value[1:]
        if name not in found or found[name][0] <= priority:
            found[name] = (priority, value)

    path = PurePosixPath(subdir)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("The project directory is outside the checkout.")
    for directory in [*reversed(path.parents), path]:
        prefix = "" if directory == PurePosixPath(".") else directory.as_posix() + "/"
        tree = commit + (":" + directory.as_posix() if prefix else "")
        records = subprocess.check_output([*git, "ls-tree", "-z", tree]).split(b"\0")
        blobs = {}
        for record in filter(None, records):
            meta, file = record.split(b"\t", 1)
            mode, _, oid = meta.split()
            if mode in (b"100644", b"100755"):
                blobs[os.fsdecode(file)] = oid.decode()

        def read(name):
            oid = blobs[name]
            if int(output([*git, "cat-file", "-s", oid])) > 2_000_000:
                raise ValueError("Environment declaration is too large: " + name)
            return output([*git, "cat-file", "blob", oid])

        if "package.json" in blobs:
            pkg = json.loads(read("package.json"))
            put("node", "lts")
            put("node", pkg.get("engines", {}).get("node"), 2)
            put("node", pkg.get("volta", {}).get("node"), 4)
            manager = re.fullmatch(r"(npm|pnpm|yarn|bun)@([^+ ]+)(?:\+.*)?", str(pkg.get("packageManager", "")))
            if manager:
                put(manager[1], manager[2], 4)
        if "pyproject.toml" in blobs:
            pyproject = tomllib.loads(read("pyproject.toml"))
            put("python")
            put("python", pyproject.get("project", {}).get("requires-python"), 2)
            if "poetry" in pyproject.get("tool", {}):
                put("poetry")
        if "requirements.txt" in blobs or "setup.py" in blobs:
            put("python")
        if "go.mod" in blobs or "go.work" in blobs:
            go = read("go.work" if "go.work" in blobs else "go.mod")
            match = re.search(r"(?m)^toolchain\s+go([\d.]+)", go) or re.search(r"(?m)^go\s+([\d.]+)", go)
            put("go", match[1] if match else "latest", 2)
        if "deno.json" in blobs or "deno.jsonc" in blobs:
            put("deno")
        if "CMakeLists.txt" in blobs:
            put("cmake")
        if "Cargo.toml" in blobs:
            put("rust", "stable")
        if "rust-toolchain" in blobs:
            put("rust", read("rust-toolchain"), 4)
        if "rust-toolchain.toml" in blobs:
            put("rust", tomllib.loads(read("rust-toolchain.toml")).get("toolchain", {}).get("channel"), 4)
        if "Gemfile" in blobs:
            put("ruby")
        if "pom.xml" in blobs:
            pom = ET.fromstring(read("pom.xml"))
            version = next((v for key in ("java.version", "maven.compiler.release", "maven.compiler.target", "maven.compiler.source")
                            if (v := pom.findtext("./{*}properties/{*}" + key)) and re.fullmatch(r"(?:1\.)?\d+", v)), None)
            put("java", version.removeprefix("1.") if version else "lts", 2 if version else 0)
            if "mvnw" not in blobs:
                put("maven")
        if "build.gradle" in blobs or "build.gradle.kts" in blobs:
            gradle = read("build.gradle" if "build.gradle" in blobs else "build.gradle.kts")
            java = re.search(r"JavaLanguageVersion\.of\(\s*(\d+)\s*\)", gradle)
            put("java", java[1] if java else "lts", 2 if java else 0)
            if "gradlew" not in blobs:
                put("gradle")
        if "global.json" in blobs:
            put("dotnet", jsonc(read("global.json")).get("sdk", {}).get("version"), 4)
        if any(n.endswith((".csproj", ".fsproj", ".sln")) for n in blobs):
            put("dotnet")
        for name, tool in LOCKS.items():
            if name in blobs:
                put(tool)
        for name in (".devcontainer.json", ".devcontainer/devcontainer.json"):
            candidates = subprocess.check_output([*git, "ls-tree", "-z", commit, "--", prefix + name])
            if not candidates.startswith(b"100644 blob ") and not candidates.startswith(b"100755 blob "):
                continue
            blobs[name] = candidates.partition(b"\t")[0].split()[-1].decode()
            for feature, options in jsonc(read(name)).get("features", {}).items():
                match = re.fullmatch(r"ghcr\.io/devcontainers/features/([\w-]+):[\w.-]+", feature)
                if match:
                    default = "stable" if match[1] == "rust" else "latest"
                    put(match[1], options.get("version", default) if isinstance(options, dict) else default, 1)
        for name, tool in VERSIONS.items():
            if name in blobs:
                put(tool, read(name).split("#", 1)[0], 4)
        if ".tool-versions" in blobs:
            for line in read(".tool-versions").splitlines():
                parts = line.partition("#")[0].split()
                if len(parts) >= 2:
                    put(parts[0], parts[1], 4, declared=True)
        for name in (".mise.toml", "mise.toml"):
            if name in blobs:
                for tool, value in tomllib.loads(read(name)).get("tools", {}).items():
                    if isinstance(value, list) and value:
                        value = value[0]
                    put(tool, value.get("version") if isinstance(value, dict) else value, 5, declared=True)
    return {k: v for k, (_, v) in found.items() if v != "system"}


def apt(packages):
    missing = [p for p in packages if subprocess.run(
        ["dpkg-query", "-W", "-f=\u0024{db:Status-Status}", p], capture_output=True, text=True).stdout != "installed"]
    if missing:
        cmd = ["sudo", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-o", "DPkg::Lock::Timeout=120"]
        subprocess.run([*cmd, "-qq", "update"], check=True)
        subprocess.run([*cmd, "-qy", "install", "--no-install-recommends", *missing], check=True)


def install(plan):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        provision(plan)


def provision(plan):
    receipt = STATE / "installed.json"
    saved = json.loads(receipt.read_text()) if receipt.exists() else {}
    if saved.get("requests") == plan and saved.get("bins") and all(Path(p).exists() for p in saved["bins"]):
        return
    mise = STATE / ("mise-" + MISE_VERSION)
    if not mise.exists():
        with tempfile.NamedTemporaryFile(dir=STATE, delete=False) as download:
            path = Path(download.name)
        try:
            url = f"https://github.com/jdx/mise/releases/download/v{MISE_VERSION}/mise-v{MISE_VERSION}-linux-arm64"
            subprocess.run(["curl", "-fsSL", "--retry", "3", "--max-time", "300", url, "-o", path], check=True)
            with path.open("rb") as data:
                if hashlib.file_digest(data, "sha256").hexdigest() != MISE_SHA:
                    raise ValueError("mise download checksum did not match.")
            path.chmod(0o755)
            path.replace(mise)
        finally:
            path.unlink(missing_ok=True)
    env = {**os.environ, "MISE_NO_CONFIG": "1", "MISE_YES": "1"}
    def run(*args):
        return output([mise, *args], cwd=STATE, env=env)

    requests = []
    for tool, version in sorted(plan.items()):
        backend = {"github-cli": "gh"}.get(tool, tool)
        if tool not in TOOLS:
            # Explicit mise/asdf names must resolve in the guest version manager's registry.
            if not run("registry", tool):
                raise ValueError("Unknown mise tool: " + tool)
        if version == "lts" and tool == "java":
            version = "21"
        is_range = bool(re.search(r"(?:^|\.)[xX](?:$|\.)|[<>=*^~|,\s]", version))
        if is_range or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}", version):
            if tool not in ("node", "python") or not re.fullmatch(r"[\dXx|.*=<>~!^,\s-]{1,160}", version):
                raise ValueError(f"Unsupported {tool} version declaration: {version[:100]}")
            releases = [v for v in run("ls-remote", backend).splitlines() if re.fullmatch(r"\d+\.\d+\.\d+", v)]
            if tool == "node":
                apt(["node-semver"])
                matches = output(["/usr/bin/semver", "-r", version, "--", *releases]).splitlines()
            else:
                apt(["python3-packaging"])
                from packaging.specifiers import SpecifierSet
                matches = list(SpecifierSet(version).filter(releases))
            if not matches:
                raise ValueError(f"No {tool} release matches {version}")
            version = max(matches, key=lambda v: tuple(map(int, v.split("."))))
        requests.append(f"{backend}@{version}")
    apt(["build-essential"] if any(t in plan for t in ("node", "rust", "python", "ruby", "cmake")) else [])
    run("install", *requests)
    # Link the concrete binaries on the service and shell PATH. Neither has to evaluate project hooks.
    bindir = Path.home() / ".local/bin"
    bindir.mkdir(parents=True, exist_ok=True)
    owned = saved.get("bins", {})
    managed = {}
    for directory in run("bin-paths", *requests).splitlines():
        for binary in Path(directory).iterdir():
            if not binary.is_file() or not os.access(binary, os.X_OK):
                continue
            link = bindir / binary.name
            if link.exists() or link.is_symlink():
                if not link.is_symlink() or str(link.readlink()) not in (owned.get(str(link)), str(binary)):
                    continue
            tmp = STATE / ".next-link"
            tmp.unlink(missing_ok=True)
            tmp.symlink_to(binary)
            tmp.replace(link)
            managed[str(link)] = str(binary)
    for old, target in owned.items():
        link = Path(old)
        if old not in managed and link.is_symlink() and str(link.readlink()) == target:
            link.unlink()
    tmp = STATE / ".receipt"
    tmp.write_text(json.dumps({"requests": plan, "bins": managed}) + "\n")
    tmp.replace(receipt)


def prepare(repo, commit, subdir):
    plan = review(repo, commit, subdir)
    if plan:
        install(plan)
    return plan


if __name__ == "__main__":
    try:
        plan = prepare(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
        print(json.dumps(plan))
    except (ValueError, TypeError, AttributeError, OSError, subprocess.CalledProcessError, ET.ParseError) as error:
        sys.exit(f"Local VM project tools: {error}")
