// @effect-diagnostics nodeBuiltinImport:off -- the Mac performs Git's remote transport for one approved repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import type * as NodeNet from "node:net";
import * as NodeUtil from "node:util";
import { forwardToGuest, guestCommand } from "./guestTunnel.ts";

declare const __T3CODE_LOCAL_VM_GIT_GUEST__: string;
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const preference = "t3code.localVmGitAuth";
const script = '"$HOME/.local/share/t3-local-vm/git/remote.py"';
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  GCM_INTERACTIVE: "never",
  PATH: (process.env.PATH ?? "") + ":/opt/homebrew/bin:/usr/local/bin",
});

export type ProjectRemote = { root: string; origin: string; pushOrigin: string };
type Service = "git-upload-pack" | "git-receive-pack";

export function portableOrigin(value: string): string | null {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  if (
    !value.includes("://") &&
    /^(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][\w.-]*:[\w./~-]+$/.test(value)
  ) {
    return value;
  }
  try {
    const url = new URL(value);
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === "https:" && url.username) ||
      !url.hostname ||
      url.pathname.length <= 1 ||
      (url.protocol === "ssh:" && !/^\/[\w./~-]+$/.test(url.pathname))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function git(root: string, args: string[]) {
  return (
    await run("/usr/bin/git", ["-C", root, ...args], {
      env: gitEnv(),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
  ).stdout.trimEnd();
}

async function matchesProjectOrigin(project: ProjectRemote) {
  const [fetch, push] = await Promise.all([
    git(project.root, ["remote", "get-url", "origin"]),
    git(project.root, ["remote", "get-url", "--push", "--all", "origin"]),
  ]).catch(() => []);
  return (
    portableOrigin(fetch ?? "") === project.origin &&
    portableOrigin(push ?? "") === project.pushOrigin
  );
}

export async function projectGitEnabled(project: ProjectRemote) {
  const value = await git(project.root, ["config", "--type=bool", "--get", preference]).catch(
    () => "",
  );
  return value === "true" && matchesProjectOrigin(project);
}

export async function setProjectGitEnabled(project: ProjectRemote, enabled: boolean) {
  if (enabled && !(await matchesProjectOrigin(project))) {
    throw new Error("The Mac checkout's origin has changed. Start a VM from its current origin.");
  }
  await git(project.root, ["config", "--local", preference, String(enabled)]);
}

function gitCredential(root: string, url: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const proc = NodeChildProcess.execFile(
      "/usr/bin/git",
      ["-C", root, "credential", "fill"],
      { env: gitEnv(), timeout: 12_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve({});
        const values: Record<string, string> = {};
        for (const line of stdout.split("\n")) {
          const split = line.indexOf("=");
          if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
        }
        resolve(values);
      },
    );
    proc.stdin?.on("error", () => {});
    proc.stdin?.end("capability[]=authtype\nurl=" + url + "\n\n");
  });
}

async function httpAuthorization(project: ProjectRemote, url: string) {
  const extra = await git(project.root, [
    "config",
    "--get-urlmatch",
    "http.extraHeader",
    url,
  ]).catch(() => "");
  const header = extra.split("\n").findLast((line) => /^authorization:\s*\S/i.test(line));
  if (header) return header.slice(header.indexOf(":") + 1).trim();
  const credential = await gitCredential(project.root, url);
  if (credential.authtype && credential.credential)
    return credential.authtype + " " + credential.credential;
  if (credential.password)
    return (
      "Basic " +
      Buffer.from((credential.username ?? "") + ":" + credential.password).toString("base64")
    );
  return undefined;
}

function selectService(name: string | null): Service | null {
  return name === "git-upload-pack" || name === "git-receive-pack" ? name : null;
}

function upstreamUrl(project: ProjectRemote, service: Service) {
  return service === "git-upload-pack" ? project.origin : project.pushOrigin;
}

function relayHttp(project: ProjectRemote, token: string) {
  return async (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
    const fail = (code: number) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(code).end();
    };
    try {
      if (req.headers["x-t3-project-git"] !== token) return fail(403);
      const base = "/origin/";
      const url = new URL(req.url ?? "/", "http://localhost");
      const discovery = req.method === "GET" && url.pathname === base + "info/refs";
      const service = selectService(
        discovery
          ? url.searchParams.get("service")
          : req.method === "POST" && url.pathname.startsWith(base)
            ? url.pathname.slice(base.length)
            : null,
      );
      if (!service) return fail(404);
      if (!(await projectGitEnabled(project))) return fail(403);
      const remote = upstreamUrl(project, service);
      if (!remote.startsWith("https://")) return fail(403);
      const next = new URL(remote);
      next.pathname = next.pathname.replace(/\/$/, "") + "/" + (discovery ? "info/refs" : service);
      if (discovery) next.searchParams.set("service", service);
      const caFile = await git(project.root, [
        "config",
        "--type=path",
        "--get-urlmatch",
        "http.sslCAInfo",
        remote,
      ]).catch(() => "");
      const authorization = await httpAuthorization(project, remote);
      const headers: Record<string, string> = { "user-agent": "git/t3-local-vm" };
      if (authorization) headers.authorization = authorization;
      if (req.headers["git-protocol"] === "version=2") headers["git-protocol"] = "version=2";
      if (!discovery) {
        headers["content-type"] = "application/x-" + service + "-request";
        if (req.headers["content-encoding"] === "gzip") headers["content-encoding"] = "gzip";
        if (req.headers["content-length"])
          headers["content-length"] = req.headers["content-length"];
      }
      if (res.destroyed) return;
      const upstream = NodeHttps.request(
        next,
        {
          method: req.method,
          headers,
          ...(caFile ? { ca: await NodeFSP.readFile(NodePath.resolve(project.root, caFile)) } : {}),
        },
        (response) => {
          const expected = "application/x-" + service + (discovery ? "-advertisement" : "-result");
          if (
            response.statusCode !== 200 ||
            response.headers["content-type"]?.split(";")[0] !== expected
          ) {
            response.destroy();
            return fail(response.statusCode === 401 || response.statusCode === 403 ? 403 : 502);
          }
          res.writeHead(200, { "content-type": expected, "cache-control": "no-store" });
          response.on("error", () => res.destroy()).pipe(res);
        },
      );
      upstream.setTimeout(180_000, () => upstream.destroy());
      upstream.on("error", () => fail(502));
      res.on("close", () => upstream.destroy());
      req.on("error", () => upstream.destroy()).pipe(upstream);
    } catch {
      fail(502);
    }
  };
}

function sshEndpoint(remote: string) {
  if (remote.startsWith("ssh://")) {
    const url = new URL(remote);
    return {
      host: (url.username ? url.username + "@" : "") + url.hostname,
      port: url.port,
      path: url.pathname,
    };
  }
  const colon = remote.indexOf(":");
  return { host: remote.slice(0, colon), port: "", path: remote.slice(colon + 1) };
}

export async function serveProjectGit(socket: string, project: ProjectRemote, token: string) {
  const server = NodeHttp.createServer(relayHttp(project, token));
  const connections = new Set<NodeNet.Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("error", () => socket.destroy()).once("close", () => connections.delete(socket));
  });
  server.on("connect", (req, channel, head) => {
    const connect = async () => {
      if (req.headers["x-t3-project-git"] !== token) return channel.destroy();
      const service = selectService(req.url?.slice(1) ?? null);
      if (!service || head.length || !(await projectGitEnabled(project))) return channel.destroy();
      const remote = upstreamUrl(project, service);
      if (remote.startsWith("https://")) return channel.destroy();
      const { host, port, path } = sshEndpoint(remote);
      const cmd =
        process.env.GIT_SSH_COMMAND ||
        (await git(project.root, ["config", "--get", "core.sshCommand"]).catch(() => ""));
      const args = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ForwardAgent=no",
        ...(port ? ["-p", port] : []),
        "--",
        host,
        service + " '" + path.replaceAll("'", "'\\\\''") + "'",
      ];
      if (channel.destroyed) return;
      // core.sshCommand is the Mac checkout's trusted Git configuration. Guest input never supplies a shell command.
      const child = NodeChildProcess.spawn(
        cmd ? "/bin/sh" : "/usr/bin/ssh",
        cmd ? ["-c", "exec " + cmd + ' "$@"', "ssh", ...args] : args,
        { cwd: project.root, env: gitEnv(), stdio: ["pipe", "pipe", "ignore"] },
      );
      channel.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      child.stdin.on("error", () => channel.destroy());
      child.on("error", () => channel.destroy());
      channel.on("close", () => child.kill());
      channel.pipe(child.stdin);
      child.stdout.pipe(channel);
    };
    void connect().catch(() => channel.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return () => {
    for (const connection of connections) connection.destroy();
    server.close();
  };
}

export function restoreProjectGit(alias: string, identity: string) {
  return guestCommand(
    alias,
    identity,
    "if test -f " + script + "; then exec /usr/bin/python3 " + script + " restore; fi",
  );
}

export async function openProjectGit(alias: string, identity: string, project: ProjectRemote) {
  const port = await guestCommand(
    alias,
    identity,
    [
      "set -eu",
      "umask 077",
      'dir="$HOME/.local/share/t3-local-vm/git"',
      'mkdir -p "$dir"',
      'temp=$(mktemp "$dir/.remote.XXXXXX")',
      "trap 'rm -f \"$temp\"' EXIT",
      'cat > "$temp"',
      'chmod 700 "$temp"',
      'mv -f "$temp" "$dir/remote.py"',
      "helper=/usr/local/bin/git-remote-t3mac",
      'if [ ! -e "$helper" ] && [ ! -L "$helper" ]; then sudo -n ln -s "$dir/remote.py" "$helper"; fi',
      'test "$(readlink "$helper")" = "$dir/remote.py"',
      "exec /usr/bin/python3 " + script + " port",
    ].join("\n"),
    __T3CODE_LOCAL_VM_GIT_GUEST__,
  );
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("The VM could not reserve a port for Git.");
  const token = NodeCrypto.randomBytes(24).toString("hex");
  return forwardToGuest(
    alias,
    identity,
    "127.0.0.1:" + port,
    "exec /usr/bin/python3 " + script + " attach",
    (socket) => serveProjectGit(socket, project, token),
    JSON.stringify([Number(port), token, [project.origin, project.pushOrigin]]) + "\n",
  );
}
