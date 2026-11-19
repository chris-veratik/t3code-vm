// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- this desktop transport uses pinned OpenSSH forwarding between private Unix sockets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { installLocalVmProvider } from "./providers.ts";
import { localVmSshArgs } from "@t3tools/ssh/localVm";
import { isCredentialError, macCredentials, type SubscriptionRequest } from "./macCredentials.ts";

declare const __T3CODE_LOCAL_VM_SUBSCRIPTION_GUEST__: string;
const agent = '"$HOME/.local/share/t3-local-vm/subscriptions/bridge.py"';
type Issue = (op: SubscriptionRequest, previous: string | null) => Promise<unknown>;

function sshArgs(alias: string) {
  const args = localVmSshArgs(alias);
  if (!args.length) throw new Error("Unknown managed local VM.");
  return [
    ...args,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ForwardX11=no",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
  ];
}

function identityCheck(identity: string) {
  const quoted = "'" + identity.replaceAll("'", "'\\''") + "'";
  return 'test "$(cat "$HOME/.t3/userdata/environment-id")" = ' + quoted + " || exit 41\n";
}

async function guestCommand(
  alias: string,
  identity: string,
  command: string,
  input = "",
  timeout = 12_000,
) {
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "/usr/bin/ssh",
      [...sshArgs(alias), alias, identityCheck(identity) + command],
      { timeout, maxBuffer: 4096 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              error.code === 41
                ? "The saved VM identity does not match its disk."
                : "Could not configure the VM over its pinned SSH connection.",
            ),
          );
        else resolve(stdout.trim());
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function restoreGuest(alias: string, identity: string) {
  return guestCommand(
    alias,
    identity,
    "if test -f " + agent + "; then exec python3 " + agent + " restore; fi",
  );
}

async function listenForCredentials(socketPath: string, issue: Issue) {
  let active = true;
  const connections = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((conn) => {
    connections.add(conn);
    conn.once("close", () => connections.delete(conn));
    conn.on("error", () => conn.destroy());
    conn.setTimeout(20_000, () => conn.destroy());
    let buffer = "";
    const receive = (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 512) {
        conn.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      conn.off("data", receive);
      const reply = async () => {
        try {
          const { op, previousAccountId } = JSON.parse(buffer);
          if (
            !active ||
            !["codex", "codex-refresh", "claude"].includes(op) ||
            (previousAccountId != null &&
              (typeof previousAccountId !== "string" || previousAccountId.length > 128))
          )
            throw new Error("Unknown request");
          const value = await issue(op, previousAccountId ?? null);
          if (active && !conn.destroyed) conn.end(JSON.stringify({ ok: true, value }) + "\n");
        } catch (error) {
          if (!conn.destroyed)
            conn.end(
              JSON.stringify({
                ok: false,
                error: isCredentialError(error)
                  ? error.message
                  : "Check subscription sharing on your Mac.",
              }) + "\n",
            );
        }
      };
      void reply();
    };
    conn.setEncoding("utf8").on("data", receive);
  });
  server.maxConnections = 24;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return () => {
    active = false;
    for (const conn of connections) conn.destroy();
    server.close();
  };
}

export async function openSubscriptionTunnel(
  alias: string,
  identity: string,
  claude: boolean,
  issue: Issue = macCredentials.issue,
) {
  const installed = await guestCommand(
    alias,
    identity,
    [
      "set -eu",
      "umask 077",
      'dir="$HOME/.local/share/t3-local-vm/subscriptions"',
      'mkdir -p "$dir"',
      'temp=$(mktemp "$dir/.bridge.XXXXXX")',
      "trap 'rm -f \"$temp\"' EXIT",
      'cat > "$temp"',
      'chmod 700 "$temp"',
      'mv -f "$temp" "$dir/bridge.py"',
      "id -u",
      "for provider in " + (claude ? "codex claude" : "codex") + "; do",
      'sh -s -- "$provider" >/dev/null 2>&1 <<\'T3_INSTALL_PROVIDER\' || echo "$provider"',
      installLocalVmProvider,
      "T3_INSTALL_PROVIDER",
      "done",
    ].join("\n"),
    __T3CODE_LOCAL_VM_SUBSCRIPTION_GUEST__,
    22 * 60_000,
  );
  const [uid = "", ...missing] = installed.split("\n");
  if (!/^\d{1,10}$/.test(uid)) throw new Error("Could not identify the VM user.");
  const directory = await NodeFSP.mkdtemp("/tmp/t3-sub-");
  const local = NodePath.join(directory, "s");
  const remote = "/run/user/" + uid + "/t3-" + NodeCrypto.randomUUID() + ".sock";
  let stopListening: (() => void) | undefined;
  try {
    stopListening = await listenForCredentials(local, issue);
    const child = NodeChildProcess.spawn(
      "/usr/bin/ssh",
      [
        ...sshArgs(alias),
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        remote + ":" + local,
        alias,
        identityCheck(identity) +
          "exec python3 " +
          agent +
          " attach " +
          remote +
          (claude ? " claude" : " codex"),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    child.stdin.on("error", () => {});
    let alive = true;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        alive = false;
        stopListening?.();
        stopListening = undefined;
        void NodeFSP.rm(directory, { recursive: true, force: true }).then(resolve, resolve);
      });
    });
    const stop = async () => {
      stopListening?.();
      stopListening = undefined;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () =>
          reject(
            new Error(
              "The VM could not attach the subscription connection. Retry in Settings → Environments.",
            ),
          );
        const timer = setTimeout(fail, 12_000);
        child.once("error", fail);
        void closed.then(() => {
          clearTimeout(timer);
          fail();
        });
        let buffer = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer === "ready\n") {
            clearTimeout(timer);
            resolve();
          } else if (buffer.length > 12) fail();
        });
      });
      return {
        claude,
        installationProblem: missing.length
          ? "Could not install " + missing.join(" and ") + " in the VM. Retry the connection."
          : null,
        get alive() {
          return alive;
        },
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  } catch (error) {
    stopListening?.();
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
