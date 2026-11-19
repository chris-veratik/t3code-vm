#!/usr/bin/python3
"""Git remote helper for one managed checkout. The Mac owns the upstream transport."""
import fcntl
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

HOME = Path.home()
DIRECTORY = HOME / ".local/share/t3-local-vm/git"
CHECKOUT = HOME / ".t3/local-vm-workspace/checkout"
ROUTE = DIRECTORY / "route.json"
GIT = ["git", "-C", str(CHECKOUT), "config", "--local"]


def restore():
    ROUTE.unlink(missing_ok=True)
    subprocess.run([*GIT, "--unset-all", "remote.origin.vcs", "^t3mac$"])


def attach():
    with (DIRECTORY / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helper = HOME / ".local/bin/git-remote-t3mac"
        helper.parent.mkdir(exist_ok=True, parents=True)
        if not helper.is_symlink():
            helper.symlink_to(Path(__file__).resolve())
        if helper.resolve() != Path(__file__).resolve():
            raise ValueError("A different t3mac remote helper is installed.")
        current = subprocess.run([*GIT, "--get", "remote.origin.vcs"], text=True, capture_output=True)
        if current.returncode == 0 and current.stdout.strip() != "t3mac":
            raise ValueError("The origin already has a custom Git transport.")
        tmp = DIRECTORY / ".route"
        tmp.write_text(json.dumps(json.loads(sys.stdin.buffer.readline(65536))))
        tmp.replace(ROUTE)
        subprocess.run([*GIT, "remote.origin.vcs", "t3mac"], check=True)
        try:
            print("ready", flush=True)
            sys.stdin.buffer.read(1)
        finally:
            restore()


def ssh_stream(service, port, token):
    with socket.create_connection(("127.0.0.1", port), timeout=15) as conn:
        conn.sendall(f"CONNECT /{service} HTTP/1.1\r\nHost: localhost\r\nX-T3-Project-Git: {token}\r\n\r\n".encode())
        source = conn.makefile("rb")
        if not source.readline(1024).startswith(b"HTTP/1.1 200 "):
            raise ValueError("Check the project's Git sign-in on your Mac.")
        while source.readline(1024) not in (b"\r\n", b""):
            pass
        conn.settimeout(None)
        def upload():
            try:
                while data := os.read(0, 65536):
                    conn.sendall(data)
                conn.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        threading.Thread(target=upload, daemon=True).start()
        while data := source.read1(65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


def remote(name, url):
    port, token, urls = json.loads(ROUTE.read_bytes())
    if name != "origin" or url not in urls:
        raise ValueError("Mac Git sharing applies to this project's origin.")
    if url.startswith("https://"):
        # This service is on guest loopback even when the guest has an outbound HTTP proxy.
        os.environ["no_proxy"] = "127.0.0.1"
        os.environ["T3_LOCAL_VM_GIT_HEADER"] = "X-T3-Project-Git: " + token
        os.execvp("git", ["git", "-c", "http.extraHeader=", "--config-env=http.extraHeader=T3_LOCAL_VM_GIT_HEADER",
                          "-c", "http.proxy=", "-c", "remote.origin.proxy=",

                          "-c", "http.followRedirects=false", "remote-http", name,
                          f"http://127.0.0.1:{port}/origin"])
    for line in iter(sys.stdin.buffer.readline, b""):
        if line == b"capabilities\n":
            print("connect\n", flush=True)
        elif line in (b"connect git-upload-pack\n", b"connect git-receive-pack\n"):
            print("", flush=True)
            ssh_stream(line.decode().split()[1], port, token)
            return
        elif line != b"\n":
            raise ValueError("Unsupported Git transport request.")


if __name__ == "__main__":
    try:
        if Path(sys.argv[0]).name == "git-remote-t3mac":
            remote(*sys.argv[1:])
        elif sys.argv[1] == "restore":
            with (DIRECTORY / "lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                restore()
        elif sys.argv[1] == "port":
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                print(s.getsockname()[1])
        elif sys.argv[1] == "attach":
            attach()
    except (OSError, ValueError, subprocess.CalledProcessError):
        sys.exit("Git could not connect to this project's origin through T3 Code on the Mac.")
