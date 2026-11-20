import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { isListedThreadLineage, type EnvironmentId } from "@t3tools/contracts";
import type {
  LocalVmInfoSchema,
  LocalVmActionSchema,
  LocalVmSubscriptionAction,
  LocalVmSubscriptionState,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Persistence } from "@t3tools/client-runtime/platform";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { readEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsSection, SettingsRow } from "./settingsLayout";

const cachedVmShellAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime.atom(
    Effect.flatMap(Persistence.EnvironmentCacheStore, (cache) => cache.loadShell(environmentId)),
  ),
);

const latestVmThreadTitleAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    if (environmentId === null) return null;
    const shell = get(environmentShell.stateValueAtom(environmentId));
    const snapshot =
      Option.getOrNull(shell.snapshot) ??
      Option.getOrNull(AsyncResult.getOrElse(get(cachedVmShellAtom(environmentId)), Option.none));
    const archive =
      shell.status === "live"
        ? AsyncResult.getOrElse(
            get(orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} })),
            () => null,
          )
        : null;
    let latest: OrchestrationV2ThreadShell | undefined;
    for (const threads of [snapshot?.threads, archive?.threads ?? snapshot?.archivedThreads]) {
      for (const thread of threads ?? []) {
        if (!thread.title.trim() || !isListedThreadLineage(thread.lineage)) continue;
        const created = DateTime.toEpochMillis(thread.createdAt);
        const latestCreated = latest ? DateTime.toEpochMillis(latest.createdAt) : -Infinity;
        if (
          !latest ||
          created > latestCreated ||
          (created === latestCreated && thread.id > latest.id)
        ) {
          latest = thread;
        }
      }
    }
    return latest?.title ?? null;
  }),
);

function LocalVmTitle({ vm }: { vm: typeof LocalVmInfoSchema.Type }) {
  const latest = useAtomValue(latestVmThreadTitleAtom(vm.environmentId));
  return (
    <span className="wrap-anywhere">
      {vm.title}
      {latest && <span className="font-normal text-muted-foreground"> · {latest}</span>}
    </span>
  );
}

export function LocalVmSettings() {
  const gt = useGT();
  const bridge = window.desktopBridge;
  const [machines, setMachines] = useState<readonly (typeof LocalVmInfoSchema.Type)[]>([]);
  const [subscriptions, setSubscriptions] = useState<LocalVmSubscriptionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const remove = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const enable = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads Lima's current inventory when the settings page opens.
  useEffect(() => {
    let active = true;
    void bridge?.listLocalVms?.().then(
      (rows) => {
        if (active) setMachines(rows);
      },
      (cause: Error) => {
        if (active) setError(cause.message);
      },
    );
    return () => {
      active = false;
    };
  }, [bridge]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- SSH connections can reconnect while this settings page is open.
  useEffect(() => {
    if (!bridge?.getLocalVmSubscriptions || busy) return;
    let active = true;
    const refresh = () =>
      void bridge.getLocalVmSubscriptions?.().then(
        (state) => {
          if (active) setSubscriptions(state);
        },
        (cause: Error) => {
          if (active) setError(cause.message);
        },
      );
    refresh();
    const timer = subscriptions?.enabled ? setInterval(refresh, 5000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bridge, busy, subscriptions?.enabled]);
  if (!machines.length && !error && !subscriptions) return null;
  const update = async (action: LocalVmSubscriptionAction) => {
    if (busy || !bridge?.updateLocalVmSubscriptions) return;
    setBusy("subscriptions");
    await bridge
      .updateLocalVmSubscriptions(action)
      .then((state) => {
        setSubscriptions(state);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };
  const act = async (
    vm: typeof LocalVmInfoSchema.Type,
    action: typeof LocalVmActionSchema.Type.action,
  ) => {
    if (busy || !bridge?.manageLocalVm) return;
    if (
      action === "delete" &&
      !(await readLocalApi()?.dialogs.confirm(
        gt(
          "Permanently delete the local VM for {title}? This removes its disk, conversation history, and unexported work.",
          { title: vm.title },
        ),
      ))
    )
      return;
    setBusy(vm.id);
    await bridge
      .manageLocalVm({ id: vm.id, action })
      .then(async () => {
        if (
          (action === "start" || action === "stop" || action === "delete") &&
          vm.environmentId &&
          readEnvironment(vm.environmentId)
        ) {
          const result =
            action === "delete"
              ? await remove(vm.environmentId)
              : await enable({ environmentId: vm.environmentId, enabled: action === "start" });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
      })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("Local VM operation failed"),
          description: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(async () => {
        try {
          setMachines((await bridge.listLocalVms?.()) ?? []);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        setBusy(null);
      });
  };
  return (
    <SettingsSection title={gt("Local VMs")}>
      {subscriptions && (
        <>
          <SettingsRow
            title={gt("Use my Mac subscriptions")}
            description={gt(
              "Use your Mac’s ChatGPT sign-in and Claude setup token in T3’s local VMs. Keep this app open while using them.",
            )}
            control={
              <Switch
                aria-label={gt("Use my Mac subscriptions")}
                checked={subscriptions.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) => void update(checked ? "enable" : "disable")}
              />
            }
          />
          {(subscriptions.enabled || subscriptions.claudeConfigured) && (
            <SettingsRow
              title={gt("Claude setup token")}
              description={
                subscriptions.claudeConfigured ? (
                  gt("Saved in your Mac Keychain. Replace it here when it expires.")
                ) : (
                  <T>
                    Run <code>claude setup-token</code> in Terminal on this Mac, then save the token
                    here once for all local VMs.
                  </T>
                )
              }
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void update("configureClaude")}
                  >
                    {subscriptions.claudeConfigured ? gt("Replace token") : gt("Save token")}
                  </Button>
                  {subscriptions.claudeConfigured && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void update("forgetClaude")}
                    >
                      <T>Remove</T>
                    </Button>
                  )}
                </div>
              }
            />
          )}
        </>
      )}
      {(error || subscriptions?.inventoryProblem) && (
        <p role="alert">{error || subscriptions?.inventoryProblem}</p>
      )}
      {subscriptions &&
        (subscriptions.inventoryProblem || Object.keys(subscriptions.problems).length > 0) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void update("retry")}
          >
            <T>Retry connection</T>
          </Button>
        )}
      {machines.map((vm) => (
        <SettingsRow
          key={vm.id}
          title={<LocalVmTitle vm={vm} />}
          description={[
            vm.id.slice(0, 8),
            vm.status,
            vm.projectGit?.problem ??
              (vm.projectGit?.connected ? gt("Mac Git connected") : undefined),
            subscriptions?.problems[vm.id] ??
              (subscriptions?.connected.includes(vm.id)
                ? gt("Mac subscriptions connected")
                : undefined),
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <div className="flex items-center gap-2">
              {vm.projectGit && (
                <label className="flex items-center gap-2 text-xs">
                  <T>Use Mac Git for this project</T>
                  <Switch
                    aria-label={gt("Use Mac Git for the project in {title}", { title: vm.title })}
                    checked={vm.projectGit.enabled}
                    disabled={busy !== null}
                    onCheckedChange={(checked) =>
                      void act(vm, checked ? "enableProjectGit" : "disableProjectGit")
                    }
                  />
                </label>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    vm,
                    vm.status === "Running" || vm.status === "Preparing" ? "stop" : "start",
                  )
                }
              >
                {vm.status === "Running" || vm.status === "Preparing" ? gt("Stop") : gt("Resume")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void act(vm, "delete")}
              >
                <T>Delete</T>
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
