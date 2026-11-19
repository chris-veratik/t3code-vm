// @effect-diagnostics nodeBuiltinImport:off -- exercises real macOS Git, Lima and OpenSSH binaries using a disposable guest.
import { expect, it, vi } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { localVmSshArgs } from "@t3tools/ssh/localVm";
import { macCredentials } from "./macCredentials.ts";
import { LocalVmSubscriptions } from "./subscriptions.ts";
import { listLocalVms, localVmSubscriptions, manageLocalVm, prepareLocalVm } from "./lima.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Opt in on an Apple Silicon Mac with Lima and a ChatGPT-capable Codex CLI installed. The short path fits Lima's Unix sockets.
it.skipIf(process.env.RUN_LIMA_INTEGRATION !== "1")(
  "boots one isolated checkout and reopens the same disk over strict SSH after a stop",
  async () => {
    const root = await NodeFSP.mkdtemp("/tmp/t3vm-");
    const id = NodeCrypto.randomUUID();
    vi.stubEnv("T3CODE_LIMA_HOME", NodePath.join(root, "lima"));
    const codexHome = NodePath.join(root, "codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.spyOn(macCredentials, "configureClaude").mockResolvedValue(true);
    vi.spyOn(macCredentials, "forgetClaude").mockResolvedValue(undefined);
    const project = NodePath.join(root, "repo");
    const cwd = NodePath.join(project, "src");
    const git = (...args: string[]) => execFile("/usr/bin/git", ["-C", project, ...args]);
    try {
      await NodeFSP.mkdir(codexHome);
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
      );
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const email = "vm-test@example.invalid";
      const jwt = [
        encode({ alg: "none" }),
        encode({
          sub: "user-fixture",
          exp: 4102444800,
          email,
          "https://api.openai.com/profile": { email },
          "https://api.openai.com/auth": {
            chatgpt_account_id: "vm-fixture-account",
            chatgpt_plan_type: "plus",
            chatgpt_user_id: "vm-test",
          },
        }),
        "Zml4dHVyZQ",
      ].join(".");
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          last_refresh: "2099-12-01T00:00:00.000Z",
          tokens: {
            access_token: jwt,
            id_token: jwt,
            refresh_token: "fixture-refresh-on-mac-only",
            account_id: "vm-fixture-account",
          },
        }),
        { mode: 0o600 },
      );
      const source = await macCredentials.issue("codex", null);
      expect(typeof source === "object" && source.accessToken === jwt).toBe(true);
      // Guest background probes may ask for a forced refresh. Keep this unsigned fixture offline.
      vi.spyOn(macCredentials, "issue").mockImplementation((op) =>
        Promise.resolve(op === "claude" ? "sk-ant-oat01-disposable-local-vm-test" : source),
      );

      expect((await localVmSubscriptions.state()).enabled).toBe(false);
      await localVmSubscriptions.update("configureClaude");
      await localVmSubscriptions.update("enable");
      await NodeFSP.mkdir(cwd, { recursive: true });
      await git("init", "-q");
      await NodeFSP.writeFile(NodePath.join(cwd, "README.md"), "committed\n");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "seed",
      );
      const commit = (await git("rev-parse", "HEAD")).stdout.trim();
      await NodeFSP.writeFile(NodePath.join(cwd, "README.md"), "uncommitted\n");
      await NodeFSP.writeFile(NodePath.join(cwd, ".env"), "host only\n");
      const upstream = NodePath.join(root, "upstream.git");
      await git("clone", "--bare", "--", project, upstream);
      const transport = NodePath.join(root, "git-ssh");
      await NodeFSP.writeFile(
        transport,
        [
          "#!/bin/sh",
          "for last do :; done",
          'case "$last" in',
          `"git-upload-pack 'fetch.git'") exec /usr/bin/git upload-pack "${upstream}" ;;`,
          `"git-receive-pack 'push.git'") exec /usr/bin/git receive-pack "${upstream}" ;;`,
          "*) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o700 },
      );
      await git("remote", "add", "origin", "git@t3-vm-test:fetch.git");
      await git("remote", "set-url", "--push", "origin", "git@t3-vm-test:push.git");
      await git("config", "core.sshCommand", transport);
      await git("config", "t3code.localVmGitAuth", "false");
      const request = { id, title: "test", cwd, revision: "HEAD" };
      const [workspace, retry] = await Promise.all([
        prepareLocalVm(request),
        prepareLocalVm(request),
      ]);
      expect(retry).toEqual(workspace);
      expect(await listLocalVms()).toHaveLength(1);
      const ssh = async (command: string) =>
        (
          await execFile("/usr/bin/ssh", [
            ...localVmSshArgs(workspace.alias),
            workspace.alias,
            command,
          ])
        ).stdout.trimEnd();
      const inProject = (command: string) => ssh(`cd "${workspace.workspaceRoot}" && ${command}`);
      expect(workspace.uninstalledProviders).toEqual([]);
      expect(workspace.projectToolsWarning).toBeUndefined();
      expect(
        await ssh('test ! -e "$HOME/.local/share/t3-local-vm/project-tools" && echo skipped'),
      ).toBe("skipped");
      await manageLocalVm({ id, action: "enableProjectGit" });
      expect(await inProject("git ls-remote --exit-code origin HEAD")).toContain(commit);
      await inProject("git fetch -q origin && git push -q origin HEAD:refs/heads/vm");
      expect(
        (
          await execFile("/usr/bin/git", ["--git-dir", upstream, "rev-parse", "refs/heads/vm"])
        ).stdout.trim(),
      ).toBe(commit);
      await manageLocalVm({ id, action: "disableProjectGit" });
      expect(await inProject("git config --get remote.origin.vcs || echo restored")).toBe(
        "restored",
      );
      const versions = () =>
        ssh('"$HOME/.local/bin/codex" --version && "$HOME/.local/bin/claude" --version');
      const python = (code: string) => ssh("python3 -c '" + code.replaceAll("'", "'\\''") + "'");
      const codexAccount = () =>
        python(`import subprocess, json, pathlib, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Workspace(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.split("?")[0].endswith("/wham/accounts/check"):
            if self.headers.get("chatgpt-account-id") != "vm-fixture-account" or not self.headers.get("Authorization", "").startswith("Bearer "):
                self.send_error(401); return
            value = {"accounts": [{"id": "vm-fixture-account", "workspace_backend_origin": "https://workspace.example.invalid", "account_routing_override":"NO_CONSTRAINT"}]}
        else:
            value = {}
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(value).encode())
backend = ThreadingHTTPServer(("127.0.0.1",0), Workspace)
threading.Thread(target=backend.serve_forever, daemon=True).start()
base = "chatgpt_base_url=http://127.0.0.1:" + str(backend.server_port) + "/backend-api/"
folder = pathlib.Path.home() / ".local/share/t3-local-vm/subscriptions"
proc = subprocess.Popen([folder / "codex", "-c", base, "app-server"], stdin=-1, stdout=-1, text=True)
def send(obj):
    proc.stdin.write(json.dumps(obj) + "\\n")
    proc.stdin.flush()
def read(id):
    for line in proc.stdout:
        msg = json.loads(line)
        if msg.get("id") == id and "method" not in msg:
            if "error" in msg: raise RuntimeError(str(msg["error"]))
            return msg["result"]
    raise RuntimeError("Provider closed before account/read")
try:
    send({"id":1,"method":"initialize","params":{"clientInfo":{"name":"t3_test","version":"1"}}})
    read(1)
    send({"method":"initialized"})
    send({"id":2,"method":"account/read","params":{}})
    print(json.dumps(read(2)["account"]))
finally:
    proc.stdin.close()
    proc.wait(timeout=10)`);
      const claudeStatus = () =>
        ssh('"$HOME/.local/share/t3-local-vm/subscriptions/claude" auth status --json');
      expect((await localVmSubscriptions.state()).connected).toEqual([id]);
      expect(JSON.parse(await codexAccount())).toMatchObject({ type: "chatgpt", planType: "plus" });
      expect(JSON.parse(await claudeStatus())).toMatchObject({ loggedIn: true });
      expect(await ssh('test ! -e "$HOME/.codex/auth.json" && echo clean')).toBe("clean");
      const installed = await versions();
      expect(installed).toMatch(/codex-cli [\d.]+/);
      expect(installed).toMatch(/[\d.]+ \(Claude Code\)/);
      expect(await inProject("git rev-parse HEAD")).toBe(commit);
      expect(await inProject("cat README.md && test ! -e .env")).toBe("committed");
      expect(await ssh("findmnt -rn -t virtiofs,9p,fuse.sshfs || true")).toBe("");
      await inProject("echo guest-only > guest-file");
      await localVmSubscriptions.update("disable");
      const checkRestored = () =>
        ssh(
          'test ! -e "$HOME/.local/share/t3-local-vm/subscriptions/active.sock" && ! grep -qs "subscriptions/codex" "$HOME/.t3/userdata/settings.json" && echo restored',
        );
      expect(await checkRestored()).toBe("restored");
      await python(`import json, pathlib
p = pathlib.Path.home()/".t3/userdata/settings.json"
s = json.loads(p.read_text()) if p.exists() else {}
s.setdefault("providerInstances", {}).setdefault("codex", {"driver":"codex"}).setdefault("config", {})["binaryPath"] = "/custom/original-codex"
p.write_text(json.dumps(s))`);
      await ssh('rm "$HOME/.local/bin/codex"');
      expect((await localVmSubscriptions.update("enable")).connected).toEqual([id]);
      expect(JSON.parse(await codexAccount())).toMatchObject({ type: "chatgpt" });
      await ssh('rm "$HOME/.local/bin/codex"');
      await manageLocalVm({ id, action: "stop" });
      expect((await listLocalVms())[0]?.status).toBe("Stopped");
      expect((await localVmSubscriptions.update("disable")).connected).toEqual([]);
      expect((await localVmSubscriptions.update("enable")).connected).toEqual([]);
      expect((await listLocalVms())[0]?.status).toBe("Stopped");
      await manageLocalVm({ id, action: "start" });
      expect(await prepareLocalVm(request)).toEqual(workspace);
      expect(await versions()).toBe(installed);
      expect((await localVmSubscriptions.state()).connected).toEqual([id]);
      await localVmSubscriptions.stopVm(id);
      const restarted = new LocalVmSubscriptions(listLocalVms);
      const stopMonitor = restarted.monitor();
      try {
        await restarted.prepare({
          id,
          environmentId: workspace.environmentId,
          title: "test",
          status: "Running",
        });
        expect((await restarted.state()).connected).toEqual([id]);
        expect(JSON.parse(await claudeStatus())).toMatchObject({ loggedIn: true });
        await restarted.update("forgetClaude");
        expect(
          await ssh(
            '! grep -qs "subscriptions/claude" "$HOME/.t3/userdata/settings.json" && echo restored',
          ),
        ).toBe("restored");
        expect(JSON.parse(await codexAccount())).toMatchObject({ type: "chatgpt" });
        await restarted.update("disable");
        expect(await checkRestored()).toBe("restored");
        expect(
          await python(
            'import json,pathlib; print(json.loads((pathlib.Path.home()/".t3/userdata/settings.json").read_text())["providerInstances"]["codex"]["config"]["binaryPath"])',
          ),
        ).toBe("/custom/original-codex");
      } finally {
        await stopMonitor();
      }
      expect(await inProject("cat guest-file")).toBe("guest-only");
      await manageLocalVm({ id, action: "delete" });
      expect(await listLocalVms()).toEqual([]);
    } finally {
      try {
        if ((await listLocalVms()).some((vm) => vm.id === id))
          await manageLocalVm({ id, action: "delete" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  },
  20 * 60_000,
);
