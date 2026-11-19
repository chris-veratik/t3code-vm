import { describe, expect, it } from "@effect/vitest";
import { localVmHome, localVmSshArgs } from "./localVm.ts";

describe("managed Lima SSH configuration", () => {
  it("pins the guest host key and picks up the current Lima port on every connection", () => {
    const name = "t3-12345678123443218123123456789abc";
    const alias = "lima-" + name;
    const args = localVmSshArgs(alias);
    expect(args.slice(0, 2)).toEqual(["-F", localVmHome() + "/" + name + "/ssh.config"]);
    expect(args).toContain("HostKeyAlias=" + alias);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain(`UserKnownHostsFile="${localVmHome()}/${name}/t3-known-hosts"`);
  });

  it("uses ordinary SSH settings for other hosts and rejects paths as managed aliases", () => {
    for (const host of [
      "devbox",
      "lima-default",
      "lima-t3-../outside",
      "lima-t3-" + "a".repeat(33),
    ]) {
      expect(localVmSshArgs(host)).toEqual([]);
    }
  });
});
