// @effect-diagnostics nodeBuiltinImport:off -- exercise real per-checkout Git configuration in a disposable repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it, vi } from "@effect/vitest";
import {
  portableOrigin,
  projectGitEnabled,
  serveProjectGit,
  setProjectGitEnabled,
} from "./projectGit.ts";

it.skipIf(!NodeFS.existsSync("/usr/bin/git"))(
  "binds the Mac sign-in to the checkout and its separate fetch and push destinations",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-project-git-"));
    const git = (...args: string[]) =>
      NodeUtil.promisify(NodeChildProcess.execFile)("/usr/bin/git", ["-C", root, ...args]);
    const project = {
      root,
      origin: "https://example.org/team/repo.git",
      pushOrigin: "git@work:fork/repo.git",
    };
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    try {
      await git("init", "-q");
      await git("remote", "add", "origin", project.origin);
      await git("remote", "set-url", "--push", "origin", project.pushOrigin);
      expect(await projectGitEnabled(project)).toBe(false);
      await setProjectGitEnabled(project, true);
      expect(await projectGitEnabled(project)).toBe(true);
      await git("remote", "set-url", "--push", "origin", "git@work:other/repo.git");
      expect(await projectGitEnabled(project)).toBe(false);
      await git("remote", "set-url", "--push", "origin", project.pushOrigin);
      await setProjectGitEnabled(project, false);
      expect(await projectGitEnabled(project)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps embedded credentials and local-only remotes out of VM records", () => {
  for (const url of [
    "file:///a/b",
    "/a/b",
    "https://user:pass@example.org/org/repo",
    "https://example.org/org/repo?key=value",
    "ext::transport",
    "git@host:ok.git\ngit@host:other.git",
  ])
    expect(portableOrigin(url)).toBeNull();
  for (const url of [
    "git@work:team/repo.git",
    "ssh://service@work:2222/team/repo.git",
    "https://work/team/repo.git",
  ])
    expect(portableOrigin(url)).toBe(url);
});

it.skipIf(!NodeFS.existsSync("/usr/bin/git"))(
  "authenticates HTTPS Git requests on the Mac for the selected origin",
  async () => {
    const root = await NodeFSP.mkdtemp("/tmp/t3-git-https-");
    const run = NodeUtil.promisify(NodeChildProcess.execFile);
    const git = (...args: string[]) => run("/usr/bin/git", ["-C", root, ...args]);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const upstream = NodeHttps.createServer();
    let close: (() => void) | undefined;
    try {
      const cert = NodePath.join(root, "local.crt");
      const key = NodePath.join(root, "local.key");
      const config = NodePath.join(root, "openssl.cnf");
      await NodeFSP.writeFile(
        config,
        "[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\n",
      );
      await run("openssl", [
        "req",
        "-new",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        cert,
      ]);
      upstream.setSecureContext({
        key: await NodeFSP.readFile(key),
        cert: await NodeFSP.readFile(cert),
      });
      let calls = 0;
      upstream.on("request", (req, res) => {
        calls++;
        const ok =
          req.headers.authorization ===
            "Basic " + Buffer.from("project-user:fixture").toString("base64") &&
          req.url === "/org/repo.git/info/refs?service=git-upload-pack";
        res
          .writeHead(ok ? 200 : 401, {
            "content-type": "application/x-git-upload-pack-advertisement",
          })
          .end();
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const port = (upstream.address() as NodeNet.AddressInfo).port;
      const origin = "https://127.0.0.1:" + port + "/org/repo.git";
      const project = { root, origin, pushOrigin: origin };
      await git("init", "-q");
      await git("remote", "add", "origin", origin);
      await git("config", "http." + origin + ".sslCAInfo", cert);
      await git("config", "credential." + origin + ".username", "project-user");
      await git(
        "config",
        "credential.helper",
        "!f() { if grep -qx username=project-user; then echo password=fixture; fi; }; f",
      );
      await setProjectGitEnabled(project, true);
      const socketPath = NodePath.join(root, "socket");
      close = await serveProjectGit(socketPath, project, "fixture-route");
      const status = (path: string, token: string) =>
        new Promise<number | undefined>((resolve, reject) => {
          NodeHttp.get(
            {
              socketPath,
              path,
              headers: { "x-t3-project-git": token, authorization: "irrelevant" },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          ).on("error", reject);
        });
      const refs = "/origin/info/refs?service=git-upload-pack";
      expect(await status(refs, "fixture-route")).toBe(200);
      expect(await status(refs, "different-route")).toBe(403);
      expect(await status("/other/info/refs?service=git-upload-pack", "fixture-route")).toBe(404);
      await setProjectGitEnabled(project, false);
      expect(await status(refs, "fixture-route")).toBe(403);
      expect(calls).toBe(1);
    } finally {
      close?.();
      upstream.close();
      vi.unstubAllEnvs();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
