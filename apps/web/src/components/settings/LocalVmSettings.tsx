import { useEffect, useState } from "react";
import type { LocalVmInfoSchema, LocalVmActionSchema } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { readEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsSection, SettingsRow } from "./settingsLayout";

export function LocalVmSettings() {
  const bridge = window.desktopBridge;
  const [machines, setMachines] = useState<readonly (typeof LocalVmInfoSchema.Type)[]>([]);
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
  if (!machines.length && !error) return null;
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
      if (vm.environmentId && readEnvironment(vm.environmentId)) {
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
      {error && <p role="alert">{error}</p>}
      {machines.map((vm) => (
        <SettingsRow
          key={vm.id}
          title={vm.title}
          description={vm.id.slice(0, 8) + " · " + vm.status}
          control={
            <div className="flex gap-2">
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
