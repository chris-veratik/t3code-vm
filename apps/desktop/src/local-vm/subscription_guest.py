#!/usr/bin/python3
"""Provider launchers for a T3-managed Lima VM. Credentials only travel on pipes and sockets."""
import fcntl
import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

HOME = Path.home()
DIRECTORY = HOME / ".local/share/t3-local-vm/subscriptions"
SETTINGS = HOME / ".t3/userdata/settings.json"
ORIGINAL = DIRECTORY / "original.json"
CURRENT = DIRECTORY / "active.sock"
PROVIDERS = {"codex": "codex", "claudeAgent": "claude"}
MISSING = "Open T3 Code on your Mac and check Settings → Environments → Local VMs."


def read_json(path):
    try:
        return json.loads(path.read_bytes())
    except FileNotFoundError:
        return {}


def write_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        try:
            f.write((json.dumps(value, indent=2) + "\n").encode())
            f.flush()
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def configure(selected):
    # Each saved field records presence as well as its value. Other provider settings stay editable.
    with (DIRECTORY / "settings.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = SETTINGS.resolve()
        for _ in range(5):
            before = read_json(path)
            settings = {**before, "providerInstances": dict(before.get("providerInstances", {}))}
            instances = settings["providerInstances"]
            saved = read_json(ORIGINAL)
            remaining = dict(saved)
            for key, cli in PROVIDERS.items():
                wrapper = str(DIRECTORY / cli)
                fields = {"binaryPath": wrapper}
                if cli == "codex":
                    fields["setupMode"] = "existing"
                enable = cli in selected
                if not enable and key not in saved:
                    continue
                entry = dict(instances.get(key, {"driver": key}))
                if entry.get("driver") != key:
                    if not enable:
                        remaining.pop(key, None)
                    continue
                config = dict(entry.get("config", {}))
                if enable:
                    if key not in saved:
                        remaining[key] = {
                            "entry": key in instances, "config": "config" in entry,
                            "fields": {k: config[k] for k in fields if k in config},
                        }
                    config.update(fields)
                else:
                    previous = remaining.pop(key)
                    for field, applied in fields.items():
                        if config.get(field) == applied:
                            if field in previous["fields"]:
                                config[field] = previous["fields"][field]
                            else:
                                config.pop(field, None)
                if config or enable or saved[key]["config"]:
                    entry["config"] = config
                else:
                    entry.pop("config", None)
                if enable or saved[key]["entry"] or entry != {"driver": key}:
                    instances[key] = entry
                else:
                    instances.pop(key, None)
            if not instances and "providerInstances" not in before:
                settings.pop("providerInstances")
            if read_json(path) != before:
                continue
            # Journal originals before publishing wrappers; complete removals after restoring them.
            if remaining != saved:
                write_json(ORIGINAL, {**saved, **remaining})
            if settings != before:
                write_json(path, settings)
            if remaining:
                if remaining != saved:
                    write_json(ORIGINAL, remaining)
            else:
                ORIGINAL.unlink(missing_ok=True)
            return
        raise RuntimeError("VM settings changed during subscription setup. Retry.")


def session(sock_path, use_claude):
    # A closing desktop or an interrupted SSH connection releases this lock automatically.
    with (DIRECTORY / "session.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not Path(sock_path).is_socket():
            raise RuntimeError("SSH forwarding is unavailable.")
        link = DIRECTORY / "next.sock"
        link.unlink(missing_ok=True)
        link.symlink_to(sock_path)
        link.replace(CURRENT)
        try:
            for cli in PROVIDERS.values():
                launcher = DIRECTORY / cli
                if not launcher.exists():
                    launcher.symlink_to("bridge.py")
            configure({"codex", "claude"} if use_claude else {"codex"})
            print("ready", flush=True)
            sys.stdin.buffer.read(1)
        finally:
            CURRENT.unlink(missing_ok=True)
            Path(sock_path).unlink(missing_ok=True)
            configure(set())


def request(op, previous=None):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(20)
        conn.connect(str(CURRENT))
        conn.sendall((json.dumps({"op": op, "previousAccountId": previous}) + "\n").encode())
        with conn.makefile("rb") as reply:
            msg = json.loads(reply.readline(65536))
    if not msg.get("ok"):
        raise RuntimeError(msg.get("error", MISSING))
    return msg["value"]


def codex(binary, args):
    # T3's stdio app-server client waits for initialize before issuing account/read or thread/start.
    # The daemon reader must not hold Python's global stdin lock during interpreter shutdown.
    source = os.fdopen(os.dup(sys.stdin.fileno()), "rb")
    sink = sys.stdout.buffer
    first = source.readline()
    if not first:
        return
    init = json.loads(first)
    if init.get("method") != "initialize":
        raise RuntimeError("Codex initialization was missing.")
    init["params"]["capabilities"] = {
        **(init["params"].get("capabilities") or {}), "experimentalApi": True,
    }
    login = request("codex")
    account = login["chatgptAccountId"]
    child = subprocess.Popen([binary, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    write_lock = threading.Lock()

    def send(line):
        with write_lock:
            child.stdin.write(line)
            child.stdin.flush()

    def rpc(msg):
        send((json.dumps(msg) + "\n").encode())

    def emit(line):
        sink.write(line)
        sink.flush()

    def refresh(msg):
        try:
            previous = msg.get("params", {}).get("previousAccountId")
            if previous and previous != account:
                raise RuntimeError("The Codex workspace changed.")
            auth = request("codex-refresh", account)
            rpc({"id": msg["id"], "result": auth})
        except (ValueError, OSError, RuntimeError):
            rpc({"id": msg["id"], "error": {"code": -32000, "message": MISSING}})

    def wait_reply(expected):
        for line in child.stdout:
            msg = json.loads(line)
            if msg.get("method") == "account/chatgptAuthTokens/refresh":
                refresh(msg)
            elif "method" not in msg and msg.get("id") == expected:
                if "error" in msg:
                    raise RuntimeError("Codex could not initialize the Mac subscription.")
                return line
            elif "method" not in msg or not msg["method"].startswith("account/"):
                emit(line)
        raise RuntimeError("Codex closed during subscription setup.")

    def forward_input():
        try:
            for line in source:
                if b'"initialized"' in line and json.loads(line).get("method") == "initialized":
                    continue
                send(line)
        except (BrokenPipeError, ValueError):
            pass
        finally:
            with write_lock:
                child.stdin.close()

    try:
        rpc(init)
        initialized = wait_reply(init["id"])
        rpc({"method": "initialized"})
        login_id = "t3-mac-subscription-login"
        rpc({"id": login_id, "method": "account/login/start",
             "params": {"type": "chatgptAuthTokens", **login}})
        wait_reply(login_id)
        del login
        emit(initialized)
        threading.Thread(target=forward_input, daemon=True).start()
        for line in child.stdout:
            if b"account/chatgptAuthTokens/refresh" in line:
                msg = json.loads(line)
                if msg.get("method") == "account/chatgptAuthTokens/refresh":
                    refresh(msg)
                    continue
            emit(line)
    finally:
        if child.poll() is None:
            child.terminate()
        child.wait()


def main():
    cli = Path(sys.argv[0]).name
    args = sys.argv[1:]
    if cli in PROVIDERS.values():
        binary = shutil.which(cli, path=f"{HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin")
        if not binary:
            raise RuntimeError(f"Could not find {cli} in this VM. Retry the subscription connection on your Mac.")
        if cli == "claude" and args not in (["--version"], ["-v"], ["--help"]):
            for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
                        "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"):
                os.environ.pop(key, None)
            os.environ["ANTHROPIC_BASE_URL"] = "https://api.anthropic.com"
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = request("claude")
        if cli == "codex" and "app-server" in args and "--help" not in args:
            codex(binary, args)
        else:
            os.execv(binary, [binary, *args])
    elif args[0] == "attach":
        session(args[1], args[2] == "claude")
    elif args[0] == "restore":
        with (DIRECTORY / "session.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            CURRENT.unlink(missing_ok=True)
            configure(set())


if __name__ == "__main__":
    def stop(signum, frame):
        raise SystemExit(0)
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, stop)
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError):
        print(MISSING, file=sys.stderr)
        sys.exit(1)
