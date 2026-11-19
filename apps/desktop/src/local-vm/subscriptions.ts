// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the Mac owns the sharing preference and each managed VM's recovery marker.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  LocalVmInfoSchema,
  LocalVmSubscriptionAction,
  LocalVmSubscriptionState,
} from "@t3tools/contracts";
import { localVmHome } from "@t3tools/ssh/localVm";
import { CredentialError, isCredentialError, macCredentials } from "./macCredentials.ts";
import { openSubscriptionTunnel, restoreGuest } from "./subscriptionTunnel.ts";

type Vm = typeof LocalVmInfoSchema.Type;
type Preference = { enabled: boolean; claudeConfigured: boolean };
type Tunnel = Awaited<ReturnType<typeof openSubscriptionTunnel>>;
const defaults = { enabled: false, claudeConfigured: false };
const records = () => NodePath.join(localVmHome(), "_t3");
const settingsFile = () => NodePath.join(records(), "mac-subscriptions.json");
const marker = (name: string) => NodePath.join(records(), name, "subscription-restore");
const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
async function readPreference(): Promise<Preference> {
  try {
    const value = JSON.parse(await NodeFSP.readFile(settingsFile(), "utf8"));
    if (typeof value.enabled !== "boolean" || typeof value.claudeConfigured !== "boolean")
      throw new Error("The Mac subscription preference could not be read.");
    return { enabled: value.enabled, claudeConfigured: value.claudeConfigured };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
}
async function savePreference(value: Preference) {
  await NodeFSP.mkdir(records(), { recursive: true, mode: 0o700 });
  const temp = settingsFile() + "." + NodeCrypto.randomUUID();
  try {
    await NodeFSP.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temp, settingsFile());
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
}

export class LocalVmSubscriptions {
  private sessions = new Map<string, Tunnel>();
  private problems = new Map<string, string>();
  private accountProblems = new Map<string, Map<string, string>>();
  private queue = Promise.resolve();
  private blocked = false;
  private claudeBlocked = false;
  private closed = false;
  private inventoryProblem: string | null = null;
  private readonly inventory: () => Promise<ReadonlyArray<Vm>>;
  constructor(inventory: () => Promise<ReadonlyArray<Vm>>) {
    this.inventory = inventory;
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async state(): Promise<LocalVmSubscriptionState> {
    return {
      ...(await readPreference()),
      connected: [...this.sessions].filter(([, tunnel]) => tunnel.alive).map(([id]) => id),
      problems: {
        ...Object.fromEntries(
          [...this.accountProblems].map(([id, errors]) => [id, [...errors.values()].join(" ")]),
        ),
        ...Object.fromEntries(this.problems),
      },
      inventoryProblem: this.inventoryProblem,
    };
  }

  private async disconnect(id: string) {
    const old = this.sessions.get(id);
    this.sessions.delete(id);
    this.accountProblems.delete(id);
    await old?.stop();
  }

  private async reconcileVm(vm: Vm, pref: Preference) {
    if (!vm.environmentId || vm.status !== "Running") return;
    const name = "t3-" + vm.id.replaceAll("-", "");
    const alias = "lima-" + name;
    const current = this.sessions.get(vm.id);
    try {
      if (this.closed) return;
      if (pref.enabled && !this.blocked) {
        if (current?.alive && current.claude === pref.claudeConfigured) return;
        await this.disconnect(vm.id);
        await NodeFSP.writeFile(marker(name), "", { mode: 0o600 });
        const tunnel = await openSubscriptionTunnel(
          alias,
          vm.environmentId,
          pref.claudeConfigured,
          async (op, previous) => {
            const allowed = () =>
              !this.closed &&
              !this.blocked &&
              (op !== "claude" || (!this.claudeBlocked && pref.claudeConfigured));
            if (!allowed())
              throw new CredentialError({
                message: "Mac subscription sharing is off for this provider.",
              });
            const provider = op === "claude" ? "Claude" : "Codex";
            let value;
            try {
              value = await macCredentials.issue(op, previous);
            } catch (error) {
              if (allowed()) {
                const errors = this.accountProblems.get(vm.id) ?? new Map<string, string>();
                errors.set(
                  provider,
                  isCredentialError(error)
                    ? error.message
                    : "Check " + provider + " authentication on your Mac.",
                );
                this.accountProblems.set(vm.id, errors);
              }
              throw error;
            }
            const errors = this.accountProblems.get(vm.id);
            errors?.delete(provider);
            if (!errors?.size) this.accountProblems.delete(vm.id);
            if (!allowed())
              throw new CredentialError({
                message: "Mac subscription sharing is off for this provider.",
              });
            return value;
          },
        );
        if (this.closed || this.blocked) await tunnel.stop();
        else {
          this.sessions.set(vm.id, tunnel);
          if (tunnel.installationProblem) {
            this.problems.set(vm.id, tunnel.installationProblem);
            return;
          }
        }
      } else {
        await this.disconnect(vm.id);
        if (await exists(marker(name))) {
          await restoreGuest(alias, vm.environmentId);
          await NodeFSP.rm(marker(name), { force: true });
        }
      }
      this.problems.delete(vm.id);
    } catch (error) {
      this.problems.set(
        vm.id,
        error instanceof Error ? error.message : "Could not connect subscription sharing.",
      );
    }
  }

  private async reconcile(pref: Preference) {
    if (this.closed) return;
    if (!pref.enabled) {
      const dir = records();
      if (!(await exists(dir))) return;
      const names = (await NodeFSP.readdir(dir)).filter((name) => /^t3-[a-f0-9]{32}$/.test(name));
      const marked = await Promise.all(names.map((name) => exists(marker(name))));
      if (!marked.some(Boolean) && !this.sessions.size) {
        this.inventoryProblem = null;
        this.problems.clear();
        return;
      }
    }
    try {
      const vms = await this.inventory();
      this.inventoryProblem = null;
      for (const id of this.sessions.keys())
        if (!vms.some((vm) => vm.id === id && vm.status === "Running")) await this.disconnect(id);
      for (const id of this.problems.keys())
        if (!vms.some((vm) => vm.id === id && vm.status === "Running")) this.problems.delete(id);
      await Promise.all(vms.map((vm) => this.reconcileVm(vm, pref)));
    } catch {
      this.inventoryProblem = "Could not reach Lima. Check that Lima is available, then retry.";
    }
  }

  prepare(vm: Vm) {
    return this.exclusive(async () => this.reconcileVm(vm, await readPreference()));
  }
  stopVm(id: string) {
    return this.exclusive(async () => {
      await this.disconnect(id);
      this.problems.delete(id);
    });
  }
  update(action: LocalVmSubscriptionAction) {
    if (action === "disable") this.blocked = true;
    if (action === "forgetClaude") this.claudeBlocked = true;
    return this.exclusive(async () => {
      const pref = { ...(await readPreference()) };
      if (action === "configureClaude") {
        if (!(await macCredentials.configureClaude())) return this.state();
        pref.claudeConfigured = true;
        this.claudeBlocked = false;
      } else if (action === "forgetClaude") {
        await macCredentials.forgetClaude();
        pref.claudeConfigured = false;
      } else if (action !== "retry") {
        pref.enabled = action === "enable";
        this.blocked = !pref.enabled;
        if (!pref.enabled) macCredentials.clearCache();
      }
      await savePreference(pref);
      if (
        !pref.enabled ||
        action === "forgetClaude" ||
        action === "configureClaude" ||
        action === "retry"
      ) {
        await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
      }
      await this.reconcile(pref);
      return this.state();
    });
  }

  monitor() {
    let refreshing = false;
    const refresh = () => {
      if (refreshing || this.closed) return;
      refreshing = true;
      void this.exclusive(async () => {
        if (await exists(settingsFile())) await this.reconcile(await readPreference());
      })
        .catch(() => {
          this.inventoryProblem = "Could not read the Mac subscription setting.";
        })
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      this.closed = true;
      await this.exclusive(async () => {
        await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
        macCredentials.clearCache();
      });
    };
  }
}
