import { useAtomValue } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderCliTerminal, type ProviderCliTerminalSession } from "./ProviderCliTerminal";
import { SettingsRow } from "./settingsLayout";

export function LocalVmProviderSetup({
  environmentId,
  driver,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderCliTerminalSession["driver"];
  readonly provider: ServerProvider;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [session, setSession] = useState<ProviderCliTerminalSession | null>(null);
  const signedIn = provider.auth.status === "authenticated";
  const refreshProvider = () => {
    void refresh({ environmentId, input: { instanceId: provider.instanceId } });
  };
  const openSetup = () => {
    if (!config || !canOperateTerminal || !provider.enabled) return;
    const platform = config.environment.platform.os;
    setSession({
      environmentId,
      driver,
      providerInstanceId: provider.instanceId,
      cwd: config.cwd,
      keybindings: config.keybindings,
      command: provider.installed
        ? resolveOnboardingProviderLoginCommand(provider, config.settings, platform, {
            headless: true,
          })
        : resolveOnboardingProviderInstallCommand(driver, platform),
    });
  };

  return (
    <>
      <SettingsRow
        title={driver === "codex" ? "ChatGPT account" : "Claude account"}
        description={
          !provider.enabled
            ? "Enable this provider to set it up in the VM."
            : signedIn
              ? "Signed in on this VM."
              : !canOperateTerminal
                ? "Terminal access is required to set up this provider in the VM."
                : "Open a terminal in this VM to connect your account."
        }
        control={
          signedIn ? undefined : (
            <Button
              size="sm"
              variant="outline"
              disabled={!config || !canOperateTerminal || !provider.enabled}
              onClick={openSetup}
            >
              {provider.installed ? "Sign in on VM" : "Install on VM"}
            </Button>
          )
        }
      />
      {session && canOperateTerminal ? (
        <ProviderCliTerminal
          key={session.command}
          session={session}
          onCommandFinished={refreshProvider}
          onClose={() => {
            setSession(null);
            refreshProvider();
          }}
        />
      ) : null}
    </>
  );
}
