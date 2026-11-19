import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, ProjectId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { environmentCatalog } from "../connection/catalog";
import { environmentSession, sessionHasScope } from "../state/session";
import { flushSync } from "react-dom";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { connectSshEnvironment } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, waitForProject } from "../state/entities";
import { readEnvironment, readPrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { environmentShell } from "../state/shell";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { toastManager } from "../components/ui/toast";
import { composerDraftContentChanged } from "../components/chat/composerSend.logic";
import { seedDraftModelSelection } from "./seedDraftModelSelection";

export async function prepareLocalVmDraft(input: {
  draftId: DraftId;
  sourceEnvironmentId: EnvironmentId;
  sourceCwd: string | null;
  revision: string | null;
  title: string;
  stillOnDraft: () => boolean;
}) {
  const { draftId, sourceEnvironmentId } = input;
  const bridge = window.desktopBridge;
  if (!bridge?.prepareLocalVm || readPrimaryEnvironmentId() !== sourceEnvironmentId)
    throw new Error("Select a project on this Mac to start a local VM.");
  const drafts = useComposerDraftStore.getState();
  const original = drafts.getDraftSession(draftId);
  const composerAtSend = drafts.getComposerDraft(draftId);
  let cancelled = false;
  const pending = () => {
    const current = useComposerDraftStore.getState().getDraftSession(draftId);
    return (
      !cancelled &&
      input.stillOnDraft() &&
      current?.environmentSelection === "local-vm" &&
      current.environmentId === sourceEnvironmentId &&
      current.projectId === original?.projectId &&
      current.branch === original.branch &&
      current.worktreePath === original.worktreePath &&
      !current.promotedTo
    );
  };
  const toast = toastManager.add({
    type: "info",
    title: "Starting local VM",
    description: input.sourceCwd
      ? "Preparing a checkout of the selected Git commit."
      : "Preparing an empty workspace.",
    timeout: 0,
    actionProps: {
      children: "Cancel",
      onClick: () => {
        cancelled = true;
        void bridge.manageLocalVm?.({ id: draftId, action: "stop" }).catch((error: Error) => {
          toastManager.add({
            type: "error",
            title: "Could not stop local VM",
            description: error.message,
          });
        });
      },
    },
  });
  try {
    const workspace = await bridge.prepareLocalVm({
      id: draftId,
      title: input.title,
      cwd: input.sourceCwd,
      revision: input.revision,
    });
    if (!pending()) return null;
    toastManager.update(toast, { title: "Connecting to local VM" });
    const { environmentId } = workspace;
    const saved = readEnvironment(environmentId);
    const route = saved && Option.getOrNull(saved.entry.profile);
    if (saved && route?._tag === "SshConnectionProfile" && route.target.alias === workspace.alias) {
      if (!saved.entry.enabled) {
        const enabled = await runAtomCommand(appAtomRegistry, environmentCatalog.setEnabled, {
          environmentId,
          enabled: true,
        });
        if (enabled._tag === "Failure") throw squashAtomCommandFailure(enabled);
      } else if (saved.connection.phase !== "connected") {
        const retry = await runAtomCommand(
          appAtomRegistry,
          environmentCatalog.retryNow,
          environmentId,
        );
        if (retry._tag === "Failure") throw squashAtomCommandFailure(retry);
      }
    } else {
      const connected = await runAtomCommand(
        appAtomRegistry,
        connectSshEnvironment,
        {
          target: { alias: workspace.alias, hostname: "127.0.0.1", port: null, username: null },
          expectedEnvironmentId: environmentId,
          label: `Local VM · ${input.title} · ${draftId.slice(0, 8)}`,
        },
        { label: "Connect local VM", reportFailure: false },
      );
      if (connected._tag === "Failure") throw squashAtomCommandFailure(connected);
    }
    // An HTTP bootstrap or a cached shell snapshot can arrive before the guest RPC session.
    const [live, authorized] = await Promise.all([
      waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentShell.statusAtom(environmentId),
        predicate: (status) => status === "live",
        timeoutMs: 60_000,
      }),
      waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentSession.sessionStateAtom(environmentId),
        predicate: (session) => sessionHasScope(session, AuthOrchestrationOperateScope),
        timeoutMs: 60_000,
      }),
    ]);
    if (!live || !authorized)
      throw new Error(
        readEnvironment(environmentId)?.connection.error ??
          "The guest did not establish an authorized T3 connection. Retry to reconnect.",
      );
    if (!pending()) return null;
    const projectId = ProjectId.make(draftId);
    const projectRef = scopeProjectRef(environmentId, projectId);
    if (!readProject(projectRef)) {
      const created = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.create,
        {
          environmentId,
          input: {
            projectId,
            title: input.title,
            workspaceRoot: workspace.workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        },
        { label: "Open project in local VM", reportFailure: false },
      );
      if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    }
    await waitForProject(projectRef);
    if (!pending()) return null;
    if (workspace.projectToolsWarning) {
      toastManager.add({
        type: "warning",
        title: "Project tools need attention",
        description: workspace.projectToolsWarning,
      });
    }
    if (workspace.uninstalledProviders?.length) {
      const names = workspace.uninstalledProviders.map((p) =>
        p === "codex" ? "Codex" : "Claude Code",
      );
      toastManager.add({
        type: "warning",
        title: `Could not install ${names.join(" and ")} in the VM`,
        description: "Open Settings → Providers for this VM to retry installation.",
      });
    }
    const composerChanged = composerDraftContentChanged(
      composerAtSend,
      useComposerDraftStore.getState().getComposerDraft(draftId),
    );
    flushSync(() => {
      drafts.setDraftThreadContext(draftId, {
        projectRef,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        envMode: "local",
        worktreePath: null,
        branch: null,
        startFromOrigin: false,
      });
      seedDraftModelSelection(draftId, projectRef);
    });
    if (composerChanged) {
      toastManager.add({
        type: "info",
        title: "Local VM ready",
        description: "Your draft changed during setup. Review it and send when ready.",
      });
      return null;
    }
    return environmentId;
  } catch (cause) {
    if (!cancelled) throw cause;
    return null;
  } finally {
    toastManager.close(toast);
  }
}
