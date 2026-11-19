"""Exercise Codex's server-initiated refresh and large stdio messages with an offline provider."""
import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

FAKE_CODEX = r'''#!/usr/bin/env python3
import json, sys
def recv(): return json.loads(sys.stdin.readline())
def send(msg): print(json.dumps(msg), flush=True)
init = recv()
assert init["params"]["capabilities"]["experimentalApi"]
send({"id": init["id"], "result": {}})
assert recv()["method"] == "initialized"
login = recv()
assert login["params"]["accessToken"] == "test-initial"
send({"id": login["id"], "result": {"type":"chatgptAuthTokens"}})
turn = recv()
send({"id": 77, "method":"account/chatgptAuthTokens/refresh",
      "params":{"reason":"unauthorized","previousAccountId":"account-test"}})
refresh = recv()
assert refresh == {"id":77, "result":{"accessToken":"test-refreshed","chatgptAccountId":"account-test"}}
send({"id": turn["id"], "result": {"size":len(turn["params"]["input"])}})
'''


class GuestProtocolTest(unittest.TestCase):
    def test_refresh_is_private_and_client_requests_remain_intact(self):
        with tempfile.TemporaryDirectory(prefix="t3g-", dir="/tmp") as tmp:
            home = Path(tmp)
            folder = home / ".local/share/t3-local-vm/subscriptions"
            folder.mkdir(parents=True)
            launcher = folder / "codex"
            (folder / "bridge.py").write_bytes(Path(__file__).with_name("subscription_guest.py").read_bytes())
            (folder / "bridge.py").chmod(0o700)
            launcher.symlink_to("bridge.py")
            binary = home / ".local/bin/codex"
            binary.parent.mkdir()
            binary.write_text(FAKE_CODEX)
            binary.chmod(0o700)
            requests = []
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(folder / "active.sock"))
                listener.listen()
                def serve():
                    for token in ("test-initial", "test-refreshed"):
                        conn, _ = listener.accept()
                        with conn, conn.makefile("rb") as stream:
                            requests.append(json.loads(stream.readline()))
                            value = {"accessToken": token, "chatgptAccountId":"account-test"}
                            conn.sendall((json.dumps({"ok":True,"value":value}) + "\n").encode())
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                messages = [
                    {"id":5,"method":"initialize","params":{"clientInfo":{"name":"fixture","version":"1"}}},
                    {"method":"initialized"},
                    {"id":"turn-id","method":"turn/start","params":{"input":"x" * 200_000}},
                ]
                with subprocess.Popen(
                    [launcher, "app-server"], cwd=home, env={**os.environ, "HOME":tmp},
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                ) as proc:
                    timeout = threading.Timer(8, proc.kill)
                    timeout.start()
                    try:
                        proc.stdin.write("".join(json.dumps(msg)+"\n" for msg in messages))
                        proc.stdin.flush()
                        received = [proc.stdout.readline(), proc.stdout.readline()]
                        proc.stdin.close()
                        proc.wait()
                        self.assertEqual(proc.returncode, 0, proc.stderr.read())
                    finally:
                        timeout.cancel()
                thread.join(2)
            self.assertEqual(requests, [
                {"op":"codex","previousAccountId":None},
                {"op":"codex-refresh","previousAccountId":"account-test"},
            ])
            self.assertEqual([json.loads(line) for line in received], [
                {"id":5,"result":{}},{"id":"turn-id","result":{"size":200_000}},
            ])


if __name__ == "__main__":
    unittest.main()
