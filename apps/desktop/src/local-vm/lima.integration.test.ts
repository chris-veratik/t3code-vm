// @effect-diagnostics nodeBuiltinImport:off -- exercises real macOS Git, Lima and OpenSSH binaries using a disposable guest.
import { expect, it, vi } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { localVmSshArgs } from "@t3tools/ssh/localVm";
import { listLocalVms, manageLocalVm, prepareLocalVm } from "./lima.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Opt in on an Apple Silicon Mac with Lima installed. The short path fits Lima's Unix sockets.
it.skipIf(process.env.RUN_LIMA_INTEGRATION !== "1")(
  "boots one isolated checkout and reopens the same disk over strict SSH after a stop",
  async () => {
    const root = await NodeFSP.mkdtemp("/tmp/t3vm-");
    const id = NodeCrypto.randomUUID();
    vi.stubEnv("T3CODE_LIMA_HOME", NodePath.join(root, "lima"));
    const project = NodePath.join(root, "repo");
    const cwd = NodePath.join(project, "src");
    const git = (...args: string[]) => execFile("/usr/bin/git", ["-C", project, ...args]);
    try {
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
      expect(await inProject("git rev-parse HEAD")).toBe(commit);
      expect(await inProject("cat README.md && test ! -e .env")).toBe("committed");
      expect(await ssh("findmnt -rn -t virtiofs,9p,fuse.sshfs || true")).toBe("");
      await inProject("echo guest-only > guest-file");
      await manageLocalVm({ id, action: "stop" });
      expect((await listLocalVms())[0]?.status).toBe("Stopped");
      await manageLocalVm({ id, action: "start" });
      expect(await prepareLocalVm(request)).toEqual(workspace);
      expect(await inProject("cat guest-file")).toBe("guest-only");
      await manageLocalVm({ id, action: "delete" });
      expect(await listLocalVms()).toEqual([]);
    } finally {
      try {
        if ((await listLocalVms()).some((vm) => vm.id === id))
          await manageLocalVm({ id, action: "delete" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  },
  20 * 60_000,
);
