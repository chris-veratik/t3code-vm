// @effect-diagnostics nodeBuiltinImport:off -- exercises the persisted opt-in and pending credential delivery using a private temporary home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { macCredentials } from "./macCredentials.ts";
import { LocalVmSubscriptions } from "./subscriptions.ts";
import * as Transport from "./subscriptionTunnel.ts";

it("denies a pending credential response as soon as sharing is disabled", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-subscription-test-"));
  vi.stubEnv("T3CODE_LIMA_HOME", home);
  const id = "11111111-1111-4111-8111-111111111111";
  const vm = { id, title: "Fixture", status: "Running", environmentId: EnvironmentId.make("test") };
  const open = vi.spyOn(Transport, "openSubscriptionTunnel").mockResolvedValue({
    alive: true,
    installationProblem: null,
    claude: false,
    stop: () => Promise.resolve(),
  });
  vi.spyOn(Transport, "restoreGuest").mockResolvedValue("");
  const value = Promise.withResolvers<string>();
  vi.spyOn(macCredentials, "issue").mockReturnValue(value.promise);
  try {
    await NodeFSP.mkdir(NodePath.join(home, "_t3", "t3-" + id.replaceAll("-", "")), {
      recursive: true,
    });
    const manager = new LocalVmSubscriptions(() => Promise.resolve([vm]));
    expect((await manager.update("enable")).connected).toEqual([id]);
    const request = open.mock.calls[0]![3]!;
    await expect(request("claude", null)).rejects.toThrow("sharing is off");
    const denied = expect(request("codex", null)).rejects.toThrow("sharing is off");
    const disabled = manager.update("disable");
    value.resolve("fixture-never-delivered");
    await denied;
    expect((await disabled).connected).toEqual([]);
    expect(await manager.state()).toMatchObject({ enabled: false, problems: {} });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
