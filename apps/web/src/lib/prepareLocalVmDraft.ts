import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type EnvironmentId,
  type LocalVmPreparationPhase,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { getActiveLocale, m } from "~/i18n/messages";
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

export interface LocalVmDraftPreparation {
  readonly phase: LocalVmPreparationPhase | "starting" | "connecting" | "stopping";
  readonly hasProject: boolean;
  readonly cancel: () => void;
}

const preparationsAtom = Atom.make<ReadonlyMap<DraftId, LocalVmDraftPreparation>>(new Map()).pipe(
  Atom.keepAlive,
);

export const localVmDraftPreparationAtom = Atom.family((draftId: DraftId | null) =>
  Atom.make((get) => (draftId === null ? null : (get(preparationsAtom).get(draftId) ?? null))),
);

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
    throw new Error(m(msg("Select a project on this Mac to start a local VM.")));
  if (appAtomRegistry.get(preparationsAtom).has(draftId)) return null;
  const drafts = useComposerDraftStore.getState();
  const original = drafts.getDraftSession(draftId);
  const composerAtSend = drafts.getComposerDraft(draftId);
  let stopping: Promise<void> | undefined;
  const pending = () => {
    const current = useComposerDraftStore.getState().getDraftSession(draftId);
    return (
      stopping === undefined &&
      input.stillOnDraft() &&
      current?.environmentSelection === "local-vm" &&
      current.environmentId === sourceEnvironmentId &&
      current.projectId === original?.projectId &&
      current.branch === original.branch &&
      current.worktreePath === original.worktreePath &&
      !current.promotedTo
    );
  };
  const cancel = () => {
    if (stopping) return;
    stopping = Promise.resolve(bridge.manageLocalVm?.({ id: draftId, action: "stop" })).catch(
      (error: Error) => {
        toastManager.add({
          type: "error",
          title: m(msg("Could not stop local VM")),
          description: error.message,
        });
      },
    );
    showPhase("stopping");
  };
  const showPhase = (phase: LocalVmDraftPreparation["phase"]) => {
    appAtomRegistry.update(preparationsAtom, (previous) =>
      new Map(previous).set(draftId, { phase, hasProject: input.sourceCwd !== null, cancel }),
    );
  };
  showPhase("starting");
  const unsubscribe = bridge.onLocalVmPreparation?.(({ id, phase }) => {
    if (id === draftId && !stopping) showPhase(phase);
  });
  try {
    const workspace = await bridge.prepareLocalVm({
      id: draftId,
      title: input.title,
      cwd: input.sourceCwd,
      revision: input.revision,
    });
    if (!pending()) return null;
    showPhase("connecting");
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
          label: m(msg("Local VM · {title} · {id}"), {
            title: input.title,
            id: draftId.slice(0, 8),
          }),
        },
        { label: m(msg("Connect local VM")), reportFailure: false },
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
          m(msg("The guest did not establish an authorized T3 connection. Retry to reconnect.")),
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
        { label: m(msg("Open project in local VM")), reportFailure: false },
      );
      if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    }
    await waitForProject(projectRef);
    if (!pending()) return null;
    if (workspace.projectToolsWarning) {
      toastManager.add({
        type: "warning",
        title: m(msg("Project tools need attention")),
        description: workspace.projectToolsWarning,
      });
    }
    if (workspace.uninstalledProviders?.length) {
      const names = workspace.uninstalledProviders.map((p) =>
        p === "codex" ? "Codex" : "Claude Code",
      );
      toastManager.add({
        type: "warning",
        title: m(msg("Could not install {providers} in the VM"), {
          providers: new Intl.ListFormat(getActiveLocale(), { type: "conjunction" }).format(names),
        }),
        description: m(msg("Open Settings → Providers for this VM to retry installation.")),
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
        title: m(msg("Local VM ready")),
        description: m(msg("Your draft changed during setup. Review it and send when ready.")),
      });
      return null;
    }
    return environmentId;
  } catch (cause) {
    if (!stopping) throw cause;
    return null;
  } finally {
    unsubscribe?.();
    if (stopping) await stopping;
    appAtomRegistry.update(preparationsAtom, (previous) => {
      const next = new Map(previous);
      next.delete(draftId);
      return next;
    });
  }
}
