import { useEffect, useState } from "react";
import type {
  LocalVmInfoSchema,
  LocalVmActionSchema,
  LocalVmSubscriptionAction,
  LocalVmSubscriptionState,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { readEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsSection, SettingsRow } from "./settingsLayout";

export function LocalVmSettings() {
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
    try {
      setSubscriptions(await bridge.updateLocalVmSubscriptions(action));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const act = async (
    vm: typeof LocalVmInfoSchema.Type,
    action: typeof LocalVmActionSchema.Type.action,
  ) => {
    if (busy || !bridge?.manageLocalVm) return;
    if (
      action === "delete" &&
      !(await readLocalApi()?.dialogs.confirm(
        `Permanently delete the local VM for ${vm.title}? This removes its disk, conversation history, and unexported work.`,
      ))
    )
      return;
    setBusy(vm.id);
    try {
      await bridge.manageLocalVm({ id: vm.id, action });
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
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Local VM operation failed",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      try {
        setMachines((await bridge.listLocalVms?.()) ?? []);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Local VMs">
      {subscriptions && (
        <>
          <SettingsRow
            title="Use my Mac subscriptions"
            description="Use your Mac’s ChatGPT sign-in and Claude setup token in T3’s local VMs. Keep this app open while using them."
            control={
              <Switch
                aria-label="Use my Mac subscriptions"
                checked={subscriptions.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) => void update(checked ? "enable" : "disable")}
              />
            }
          />
          {(subscriptions.enabled || subscriptions.claudeConfigured) && (
            <SettingsRow
              title="Claude setup token"
              description={
                subscriptions.claudeConfigured ? (
                  "Saved in your Mac Keychain. Replace it here when it expires."
                ) : (
                  <>
                    Run <code>claude setup-token</code> in Terminal on this Mac, then save the token
                    here once for all local VMs.
                  </>
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
                    {subscriptions.claudeConfigured ? "Replace token" : "Save token"}
                  </Button>
                  {subscriptions.claudeConfigured && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void update("forgetClaude")}
                    >
                      Remove
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
            Retry connection
          </Button>
        )}
      {machines.map((vm) => (
        <SettingsRow
          key={vm.id}
          title={vm.title}
          description={[
            vm.id.slice(0, 8),
            vm.status,
            vm.projectGit?.problem ?? (vm.projectGit?.connected ? "Mac Git connected" : undefined),
            subscriptions?.problems[vm.id] ??
              (subscriptions?.connected.includes(vm.id)
                ? "Mac subscriptions connected"
                : undefined),
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <div className="flex items-center gap-2">
              {vm.projectGit && (
                <label className="flex items-center gap-2 text-xs">
                  Use Mac Git for this project
                  <Switch
                    aria-label={`Use Mac Git for the project in ${vm.title}`}
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
                {vm.status === "Running" || vm.status === "Preparing" ? "Stop" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void act(vm, "delete")}
              >
                Delete
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
