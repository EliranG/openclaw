import { resolveSessionEntry } from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import {
  resolveSandboxRuntimeStatus,
  withLegacySandboxRuntimeStatusReader,
  type SandboxRuntimeStatusParams,
} from "./runtime-status.js";

/** @deprecated Await resolveSandboxRuntimeStatusAsync. Removed in the next Plugin SDK major. */
export function resolveSandboxRuntimeStatusLegacy(params: SandboxRuntimeStatusParams) {
  warnPluginSdkDeprecation({
    family: "sandbox-runtime-status",
    method: "resolveSandboxRuntimeStatus",
    replacement: "resolveSandboxRuntimeStatusAsync",
  });
  return withLegacySandboxRuntimeStatusReader(
    (scope) => resolveSessionEntry({ ...scope, clone: false }, { readOnly: true }).existing,
    () => resolveSandboxRuntimeStatus(params),
  );
}
