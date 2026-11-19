// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the desktop owns a private service socket and the pinned SSH process forwarding it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { localVmSshArgs } from "@t3tools/ssh/localVm";

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

export async function guestCommand(
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

export async function forwardToGuest(
  alias: string,
  identity: string,
  remote: string,
  command: string,
  listen: (path: string) => Promise<() => void>,
  initialInput?: string,
) {
  const directory = await NodeFSP.mkdtemp("/tmp/t3-vm-link-");
  const local = NodePath.join(directory, "s");
  let stopListening: (() => void) | undefined;
  try {
    stopListening = await listen(local);
    const child = NodeChildProcess.spawn(
      "/usr/bin/ssh",
      [
        ...sshArgs(alias),
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        remote + ":" + local,
        alias,
        identityCheck(identity) + command,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    child.stdin.on("error", () => {});
    if (initialInput) child.stdin.write(initialInput);
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
              "The VM could not attach the Mac connection. Retry in Settings → Environments.",
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
