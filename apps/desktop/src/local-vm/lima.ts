// @effect-diagnostics nodeBuiltinImport:off -- This macOS driver owns native limactl and git processes, cancellation, and atomic on-disk state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, type LocalVmLaunch, type LocalVmActionSchema } from "@t3tools/contracts";
import { localVmHome } from "@t3tools/ssh/localVm";
import { installGuestHostKey, installGuestService, localVmTemplate } from "./template.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
type LaunchRecord = LocalVmLaunch & {
  root: string | null;
  commit: string | null;
  subdirectory: string;
  origin: string | null;
};

function machineName(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("Invalid local VM ID.");
  }
  return "t3-" + id.replaceAll("-", "");
}

const recordDir = (id: string) => NodePath.join(localVmHome(), "_t3", machineName(id));
const exists = (file: string) =>
  NodeFSP.access(file).then(
    () => true,
    () => false,
  );

async function lima(args: string[], signal?: AbortSignal) {
  const env = {
    ...process.env,
    LIMA_HOME: localVmHome(),
    PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`,
  };
  try {
    return (
      await execute("limactl", ["--tty=false", ...args], {
        env,
        signal,
        timeout: 20 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (cause) {
    if (signal?.aborted) throw new Error("Local VM launch cancelled.", { cause });
    const failure = cause as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT")
      throw new Error("Install Lima on this Mac with brew install lima, then retry.", { cause });
    throw new Error(
      failure.stderr?.trim().slice(-1600) || "Lima could not complete the operation.",
      { cause },
    );
  }
}

async function inventory() {
  if (!(await exists(localVmHome()))) return [];
  const rows = await lima(["list", "--json"]);
  return rows
    .split("\n")
    .filter(Boolean)
    .map((row): { name: string; status: string } => JSON.parse(row));
}

async function git(cwd: string, args: string[]) {
  return (
    await execute("/usr/bin/git", ["-C", cwd, ...args], {
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trimEnd();
}

function portableOrigin(value: string) {
  if (/^git@[\w.-]+:[\w./-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      ["https:", "ssh:"].includes(url.protocol) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.username || (url.protocol === "ssh:" && url.username === "git"))
    )
      return url.href;
  } catch {
    /* Local paths stay on the source machine. */
  }
  return null;
}

async function recordLaunch(input: LocalVmLaunch): Promise<LaunchRecord> {
  const dir = recordDir(input.id);
  const file = NodePath.join(dir, "launch.json");
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await exists(file))) {
    let root = null;
    let commit = null;
    let subdirectory = "";
    let origin = null;
    if (input.cwd !== null) {
      if (!NodePath.isAbsolute(input.cwd))
        throw new Error("The source checkout must have an absolute path.");
      const cwd = await NodeFSP.realpath(input.cwd);
      root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => {
        throw new Error(
          "Choose a Git project with a commit, or start a scratch thread for an empty VM.",
        );
      });
      commit = await git(cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        (input.revision || "HEAD") + "^{commit}",
      ]);
      subdirectory = NodePath.relative(await NodeFSP.realpath(root), cwd);
      origin = portableOrigin(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
    }
    const temp = await NodeFSP.mkdtemp(NodePath.join(dir, ".launch-"));
    try {
      const candidate = NodePath.join(temp, "record");
      await NodeFSP.writeFile(
        candidate,
        JSON.stringify({ ...input, root, commit, subdirectory, origin }),
        {
          mode: 0o600,
        },
      );
      await NodeFSP.link(candidate, file).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  }
  const saved: LaunchRecord = JSON.parse(await NodeFSP.readFile(file, "utf8"));
  if (saved.cwd !== input.cwd || saved.revision !== input.revision) {
    throw new Error(
      "This launch already targets another revision. Use a new draft for the new checkout.",
    );
  }
  return saved;
}

async function startMachine(id: string, signal?: AbortSignal) {
  const name = machineName(id);
  const vm = (await inventory()).find((row) => row.name === name);
  if (!vm) {
    if (await exists(NodePath.join(recordDir(id), "environment-id")))
      throw new Error("The saved VM disk is missing. Restore that disk to reopen its threads.");
    const template = NodePath.join(recordDir(id), "template.yaml");
    await NodeFSP.writeFile(template, localVmTemplate, { mode: 0o600 });
    await lima(["start", "--name=" + name, template], signal);
  } else if (vm.status !== "Running") {
    await lima(["start", name], signal);
  }
  const guest = (args: string[]) => lima(["shell", "--workdir=/", name, ...args], signal);
  const alias = "lima-" + name;
  const knownHosts = NodePath.join(localVmHome(), name, "t3-known-hosts");
  if (!(await exists(knownHosts))) {
    const key = await guest(["sudo", "sh", "-c", installGuestHostKey]);
    const match = /^ssh-ed25519 ([a-zA-Z0-9+/=]+)(?: [^\n]*)?$/.exec(key);
    if (!match) throw new Error("Lima returned an invalid guest host key.");
    await NodeFSP.writeFile(knownHosts, `${alias} ssh-ed25519 ${match[1]}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return { name, alias, guest };
}

async function prepare(input: LocalVmLaunch, signal: AbortSignal) {
  const record = await recordLaunch(input);
  const { name, alias, guest } = await startMachine(input.id, signal);
  await guest(["sh", "-c", installGuestService]);
  const home = await guest(["sh", "-c", 'printf %s "$HOME"']);
  const identityFile = NodePath.join(recordDir(input.id), "environment-id");
  const environmentId = EnvironmentId.make(
    await guest(["cat", home + "/.t3/userdata/environment-id"]),
  );
  if (await exists(identityFile)) {
    if ((await NodeFSP.readFile(identityFile, "utf8")) !== environmentId)
      throw new Error("The VM’s T3 identity changed. Restore the saved disk to resume.");
  } else {
    await NodeFSP.writeFile(identityFile, environmentId, { flag: "wx", mode: 0o600 });
  }
  const workspace = home + "/.t3/local-vm-workspace";
  if (
    (await guest([
      "sh",
      "-c",
      'if test -d "$1/checkout"; then echo ready; fi',
      "sh",
      workspace,
    ])) !== "ready"
  ) {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-vm-seed-"));
    try {
      if (record.root && record.commit) {
        // Name the frozen commit in a temporary repository so the source's refs never change.
        await git(temp, ["init", "--bare"]);
        await git(temp, [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          record.root,
          record.commit + ":refs/heads/workspace",
        ]);
        const bundle = NodePath.join(temp, "source.bundle");
        await git(temp, ["bundle", "create", bundle, "refs/heads/workspace"]);
        await lima(["copy", bundle, name + ":" + home + "/.t3/source.bundle"], signal);
      }
      await guest([
        "sh",
        "-eu",
        "-c",
        `stage=$(mktemp -d "$HOME/.t3/seed.XXXXXX")
trap 'rm -rf "$stage"' EXIT
if [ -n "$2" ]; then
  git clone -q -b workspace "$HOME/.t3/source.bundle" "$stage/checkout"
  test "$(git -C "$stage/checkout" rev-parse HEAD)" = "$2"
  git -C "$stage/checkout" remote remove origin
  if [ -n "$3" ]; then git -C "$stage/checkout" remote add origin "$3"; fi
else
  mkdir "$stage/checkout"
fi
mv -T "$stage" "$1"
rm -f "$HOME/.t3/source.bundle"`,
        "sh",
        workspace,
        record.commit ?? "",
        record.origin ?? "",
      ]);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  }
  return {
    alias,
    environmentId,
    workspaceRoot: NodePath.join(workspace, "checkout", record.subdirectory),
  };
}

const operations = new Map<string, Promise<unknown>>();
const launches = new Map<
  string,
  {
    input: LocalVmLaunch;
    controller: AbortController;
    task: Promise<Awaited<ReturnType<typeof prepare>>>;
  }
>();
function serialize<T>(id: string, run: () => Promise<T>) {
  const next = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
  operations.set(id, next);
  return next.finally(() => {
    if (operations.get(id) === next) operations.delete(id);
  });
}

export function prepareLocalVm(input: LocalVmLaunch) {
  const active = launches.get(input.id);
  if (active) {
    if (active.input.cwd !== input.cwd || active.input.revision !== input.revision) {
      return Promise.reject(new Error("This VM is already preparing another checkout."));
    }
    return active.task;
  }
  const controller = new AbortController();
  const task = serialize(input.id, () => prepare(input, controller.signal)).finally(() =>
    launches.delete(input.id),
  );
  launches.set(input.id, { input, controller, task });
  return task;
}

export async function listLocalVms() {
  const dir = NodePath.join(localVmHome(), "_t3");
  if (!(await exists(dir))) return [];
  const machines = await inventory();
  const entries = await NodeFSP.readdir(dir);
  const result = [];
  for (const name of entries) {
    const file = NodePath.join(dir, name, "launch.json");
    if (!/^t3-[a-f0-9]{32}$/.test(name) || !(await exists(file))) continue;
    const record: LaunchRecord = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    const identity = NodePath.join(dir, name, "environment-id");
    const environmentId = (await exists(identity))
      ? EnvironmentId.make(await NodeFSP.readFile(identity, "utf8"))
      : null;
    result.push({
      id: record.id,
      title: record.title,
      environmentId,
      status: launches.has(record.id)
        ? "Preparing"
        : (machines.find((row) => row.name === name)?.status ?? "Pending"),
    });
  }
  return result;
}

export async function manageLocalVm({ id, action }: typeof LocalVmActionSchema.Type) {
  if (action === "start") {
    const record: LaunchRecord = JSON.parse(
      await NodeFSP.readFile(NodePath.join(recordDir(id), "launch.json"), "utf8"),
    );
    await prepareLocalVm(record);
    return;
  }
  launches.get(id)?.controller.abort();
  return serialize(id, async () => {
    const dir = recordDir(id);
    if (!(await exists(NodePath.join(dir, "launch.json"))))
      throw new Error("Unknown managed local VM.");
    const name = machineName(id);
    const machine = (await inventory()).find((row) => row.name === name);
    if (machine && machine.status !== "Stopped") await lima(["stop", name]);
    if (action === "delete") {
      if (machine) await lima(["delete", name]);
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
}
