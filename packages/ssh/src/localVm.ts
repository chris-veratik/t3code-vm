// @effect-diagnostics nodeBuiltinImport:off -- OpenSSH needs an absolute path to its Mac-side configuration.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// The renderer supplies an opaque alias. Only the desktop chooses which ssh configuration to read.
export function localVmHome() {
  return process.env.T3CODE_LIMA_HOME || NodePath.join(NodeOS.homedir(), ".t3", "lima");
}

export function localVmSshArgs(alias: string): string[] {
  if (!/^lima-t3-[a-f0-9]{32}$/.test(alias)) return [];
  const directory = NodePath.join(localVmHome(), alias.slice("lima-".length));
  return [
    "-F",
    NodePath.join(directory, "ssh.config"),
    "-o",
    "ControlPath=none",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `HostKeyAlias=${alias}`,
    "-o",
    `UserKnownHostsFile="${NodePath.join(directory, "t3-known-hosts")}"`,
  ];
}
