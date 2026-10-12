import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import type { DraftPlaceCallbacks, DraftPlaceSnapshot } from "./draft-place-contract.ts";
import type { createDraftPlaceRestoreState } from "./draft-place-restore.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftRepositoryController } from "./draft-repository-state.ts";
import type { DraftRestoredFolderValidation } from "./folder-validation.ts";
import {
  environmentDeviceDisabledReason,
  environmentCloudDisabledReason,
} from "./hosted-environments.ts";
import type { NewSessionModelControl } from "./model-control.ts";
import { resolveNewSessionWhere } from "./preferences.ts";

type DraftTargetContext = {
  place: Pick<
    DraftPlaceState,
    "requiredPlacement" | "hostedEnvironment" | "devices" | "worktree" | "isAdmin" | "folder"
  >;
  read: () => DraftPlaceSnapshot;
  selection: ReturnType<typeof createDraftPlaceRestoreState>;
  gateway: DraftGatewayState;
  callbacks: DraftPlaceCallbacks;
  folderValidation: DraftRestoredFolderValidation;
  repositoryState: DraftRepositoryController;
  browser: DraftPlaceBrowser;
  modelControl: NewSessionModelControl;
  persistPreference: (patch: Parameters<DraftGatewayState["persistPreference"]>[2]) => void;
  clearDeviceFolder: () => void;
};

export function selectDraftDevice(
  context: DraftTargetContext,
  deviceId: string,
  autoDevice = false,
) {
  const snapshot = context.read();
  if (
    context.place.requiredPlacement ||
    snapshot.submitting ||
    snapshot.pendingPlacementSessionKey
  ) {
    return;
  }
  if (
    context.place.hostedEnvironment &&
    (deviceId || autoDevice) &&
    environmentDeviceDisabledReason(context.modelControl)
  ) {
    return;
  }
  if (!context.modelControl.selectHostEnvironment()) {
    return;
  }
  if (
    (deviceId &&
      context.place.devices().find((device) => device.deviceId === deviceId)?.selectable !==
        true) ||
    (autoDevice && !context.place.devices().some((device) => device.selectable))
  ) {
    return;
  }
  context.selection.whereSelectedByUser = true;
  context.selection.preferredWhereRestore = null;
  if (
    deviceId === context.selection.deviceId &&
    autoDevice === context.selection.autoDevice &&
    !context.selection.cloudProfileId
  ) {
    context.browser.close();
    context.callbacks.requestUpdate();
    return;
  }
  context.folderValidation.cancel();
  context.clearDeviceFolder();
  context.selection.deviceId = deviceId;
  context.selection.autoDevice = autoDevice;
  context.selection.cloudProfileId = "";
  context.persistPreference({
    where: resolveNewSessionWhere({ cloudProfileId: "", deviceId, autoDevice }),
    projectId: context.browser.projectId,
    folder: context.place.folder,
    worktree: Boolean(deviceId || autoDevice) || context.place.worktree,
    freshWorkspace: context.selection.freshWorkspace,
  });
  context.browser.close();
  context.repositoryState.synchronize();
  context.callbacks.requestUpdate();
}

export function selectDraftCloudProfile(context: DraftTargetContext, profileId: string) {
  const snapshot = context.read();
  const profile = context.gateway.cloudProfiles.find((candidate) => candidate.id === profileId);
  if (
    snapshot.submitting ||
    snapshot.pendingPlacementSessionKey ||
    context.place.requiredPlacement ||
    !context.place.isAdmin() ||
    !profile ||
    Boolean(environmentCloudDisabledReason(context.modelControl, profile)) ||
    !context.modelControl.selectHostEnvironment()
  ) {
    return;
  }
  context.clearDeviceFolder();
  context.selection.cloudProfileId = profileId;
  context.selection.deviceId = "";
  context.selection.autoDevice = false;
  context.selection.whereSelectedByUser = true;
  context.selection.preferredWhereRestore = null;
  context.callbacks.onError(null);
  context.persistPreference({
    where: { kind: "cloud", id: profileId },
    projectId: context.browser.projectId,
    worktree: true,
    freshWorkspace: context.selection.freshWorkspace,
  });
  context.repositoryState.synchronize();
  context.callbacks.requestUpdate();
}

export function selectDraftWorktree(context: DraftTargetContext, value: boolean) {
  if (context.read().submitting || !context.repositoryState.select(value)) {
    return;
  }
  if (value && context.selection.freshWorkspace) {
    context.selection.freshWorkspace = false;
    context.persistPreference({ freshWorkspace: false });
  }
}
