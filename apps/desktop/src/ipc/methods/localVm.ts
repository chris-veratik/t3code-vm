import {
  LocalVmActionSchema,
  LocalVmSubscriptionActionSchema,
  LocalVmSubscriptionStateSchema,
  LocalVmInfoSchema,
  LocalVmLaunchSchema,
  LocalVmWorkspaceSchema,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Lima from "../../local-vm/lima.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

class LocalVmRequestError extends Schema.TaggedError<LocalVmRequestError>()("LocalVmRequestError", {
  message: Schema.String,
}) {}

const run = Effect.fn("DesktopLocalVm.run")(function* <T>(operation: () => Promise<T>) {
  if ((yield* HostProcess.Platform) !== "darwin" || (yield* HostProcess.Architecture) !== "arm64") {
    return yield* new LocalVmRequestError({ message: "Local VMs require an Apple Silicon Mac." });
  }
  return yield* Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new LocalVmRequestError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

export const prepareLocalVm = makeIpcMethod({
  channel: Channels.PREPARE_LOCAL_VM_CHANNEL,
  payload: LocalVmLaunchSchema,
  result: LocalVmWorkspaceSchema,
  handler: (input) => run(() => Lima.prepareLocalVm(input)),
});
export const listLocalVms = makeIpcMethod({
  channel: Channels.LIST_LOCAL_VMS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LocalVmInfoSchema),
  handler: () => run(Lima.listLocalVms),
});
export const manageLocalVm = makeIpcMethod({
  channel: Channels.MANAGE_LOCAL_VM_CHANNEL,
  payload: LocalVmActionSchema,
  result: Schema.Void,
  handler: (input) => run(() => Lima.manageLocalVm(input)),
});

export const getLocalVmSubscriptions = makeIpcMethod({
  channel: Channels.GET_LOCAL_VM_SUBSCRIPTIONS_CHANNEL,
  payload: Schema.Void,
  result: LocalVmSubscriptionStateSchema,
  handler: () => run(() => Lima.localVmSubscriptions.state()),
});
export const updateLocalVmSubscriptions = makeIpcMethod({
  channel: Channels.UPDATE_LOCAL_VM_SUBSCRIPTIONS_CHANNEL,
  payload: LocalVmSubscriptionActionSchema,
  result: LocalVmSubscriptionStateSchema,
  handler: (action) => run(() => Lima.localVmSubscriptions.update(action)),
});

export const monitorLocalVmSubscriptions = Effect.fn("DesktopLocalVm.monitorSubscriptions")(
  function* () {
    if (
      (yield* HostProcess.Platform) === "darwin" &&
      (yield* HostProcess.Architecture) === "arm64"
    ) {
      const close = Lima.localVmSubscriptions.monitor();
      yield* Effect.addFinalizer(() => Effect.promise(close));
    }
  },
);
