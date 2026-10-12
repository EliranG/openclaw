import fsSync from "node:fs";
import path from "node:path";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
const SHA = /^[a-f0-9]{40}$/u;

export function directoryIdentity(file: string): string {
  const stat = fsSync.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
    throw new Error(`Immutable installation directory must be root-owned and protected: ${file}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

export function readImmutableLayout(root: string) {
  if (fsSync.realpathSync(root) !== root) {
    throw new Error("Immutable installation must have a canonical physical root.");
  }
  const rootIdentity = directoryIdentity(root);
  const releases = path.join(root, "releases");
  const releasesIdentity = directoryIdentity(releases);
  const pointer = path.join(root, "current");
  const stat = fsSync.lstatSync(pointer, { bigint: true });
  const target = stat.isSymbolicLink() ? fsSync.readlinkSync(pointer) : "";
  const generationPath = path.resolve(root, target);
  const sha = path.basename(generationPath);
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    !SHA.test(sha) ||
    path.dirname(generationPath) !== releases
  ) {
    throw new Error(
      "Immutable current must select a root-owned direct releases/<40-hex SHA> generation.",
    );
  }
  const identity = directoryIdentity(generationPath);
  if (
    fsSync.realpathSync(pointer) !== generationPath ||
    rootIdentity.split(":")[0] !== releasesIdentity.split(":")[0] ||
    identity.split(":")[0] !== releasesIdentity.split(":")[0]
  ) {
    throw new Error("Immutable release layout must be contained on one filesystem.");
  }
  return {
    identityEncoding: "exact" as const,
    rootIdentity,
    releasesIdentity,
    current: { sha, path: generationPath, identity, pointerIdentity: `${stat.dev}:${stat.ino}` },
  };
}

/** Old numeric receipts remain readable but cannot authorize an ambiguous large file ID. */
export function assertImmutableIdentityEncoding(
  encoding: "exact" | undefined,
  identities: readonly string[],
): void {
  if (
    encoding !== "exact" &&
    identities.some((identity) =>
      identity
        .split(":")
        .some((value) => !/^\d+$/u.test(value) || BigInt(value) > 9007199254740991n),
    )
  ) {
    throw new Error(
      "Legacy immutable receipt contains an imprecise file identity; it was preserved and cannot authorize recovery. Re-adopt the installation after completing recovery with its original updater.",
    );
  }
}

export function assertImmutableDescriptorIdentityEncoding(
  descriptor: ImmutableInstallDescriptor,
): void {
  assertImmutableIdentityEncoding(descriptor.identityEncoding, [
    descriptor.rootIdentity,
    descriptor.releasesIdentity,
    descriptor.current.identity,
    descriptor.current.pointerIdentity,
  ]);
}

export function assertImmutableDescriptorCurrent(descriptor: ImmutableInstallDescriptor): void {
  assertImmutableDescriptorIdentityEncoding(descriptor);
  const layout = readImmutableLayout(descriptor.root);
  if (
    layout.rootIdentity !== descriptor.rootIdentity ||
    layout.releasesIdentity !== descriptor.releasesIdentity ||
    (["sha", "path", "identity", "pointerIdentity"] as const).some(
      (key) => layout.current[key] !== descriptor.current[key],
    ) ||
    packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity
  ) {
    throw new Error("Immutable installation changed since adoption; current was not modified.");
  }
}
