// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- this desktop transport uses pinned OpenSSH forwarding between private Unix sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { installLocalVmProvider } from "./providers.ts";
import { forwardToGuest, guestCommand } from "./guestTunnel.ts";
import { isCredentialError, macCredentials, type SubscriptionRequest } from "./macCredentials.ts";

declare const __T3CODE_LOCAL_VM_SUBSCRIPTION_GUEST__: string;
const agent = '"$HOME/.local/share/t3-local-vm/subscriptions/bridge.py"';
type Issue = (op: SubscriptionRequest, previous: string | null) => Promise<unknown>;

export function restoreGuest(alias: string, identity: string) {
  return guestCommand(
    alias,
    identity,
    "if test -f " + agent + "; then exec /usr/bin/python3 " + agent + " restore; fi",
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
  const remote = "/run/user/" + uid + "/t3-" + NodeCrypto.randomUUID() + ".sock";
  const tunnel = await forwardToGuest(
    alias,
    identity,
    remote,
    "exec /usr/bin/python3 " + agent + " attach " + remote + (claude ? " claude" : " codex"),
    (local) => listenForCredentials(local, issue),
  );
  return {
    claude,
    installationProblem: missing.length
      ? "Could not install " + missing.join(" and ") + " in the VM. Retry the connection."
      : null,
    get alive() {
      return tunnel.alive;
    },
    stop: tunnel.stop,
  };
}
