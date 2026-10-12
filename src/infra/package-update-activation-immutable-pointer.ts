import fs from "node:fs";
import path from "node:path";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import {
  assertImmutableInstallRecordCurrent,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";
import {
  assertImmutableDescriptorCurrent,
  assertImmutableDescriptorIdentityEncoding,
  assertImmutableIdentityEncoding,
  directoryIdentity,
  readImmutableLayout,
} from "./update-immutable-layout.js";

/** Reconcile a durable rename intent before deciding whether any effect needs replay. */
export function reconcileImmutablePointer(
  record: ImmutableInstallRecord,
  assertCurrent: () => void,
): ImmutableInstallRecord {
  assertCurrent();
  assertImmutableDescriptorIdentityEncoding(record.descriptor);
  const operation = record.activation?.operation;
  const intent = operation?.pointerIntent;
  if (!operation || !intent) {
    assertImmutableDescriptorCurrent(record.descriptor);
    return record;
  }
  assertImmutableIdentityEncoding(intent.identityEncoding, [
    intent.fromIdentity,
    intent.temporaryIdentity,
  ]);
  const layout = readImmutableLayout(record.descriptor.root);
  if (layout.current.pointerIdentity === intent.fromIdentity) {
    assertImmutableDescriptorCurrent(record.descriptor);
    return record;
  }
  const target =
    intent.targetSha === operation.candidate.sha ? operation.candidate : operation.previous;
  if (
    layout.current.pointerIdentity !== intent.temporaryIdentity ||
    layout.current.sha !== target.sha ||
    layout.current.identity !== target.identity
  ) {
    throw new Error(
      "Immutable pointer differs from its durable publication intent; recovery retained.",
    );
  }
  const descriptor = {
    ...record.descriptor,
    current: { ...layout.current, buildDigest: target.buildDigest },
  };
  assertImmutableDescriptorCurrent(descriptor);
  assertCurrent();
  requireDirectorySync(syncDirectorySync(record.descriptor.root), "Immutable pointer publication");
  const { pointerIntent: _intent, ...observed } = operation;
  return updateImmutableInstallRecord(
    record,
    {
      ...record,
      descriptor,
      activation: { ...record.activation, operation: observed },
    },
    assertCurrent,
  );
}

/** The caller proves stopped-service custody; this owner records intent before atomic publication. */
export function publishImmutablePointer(
  record: ImmutableInstallRecord,
  target: "candidate" | "previous",
  assertCurrent: () => void,
): ImmutableInstallRecord {
  let current = reconcileImmutablePointer(record, assertCurrent);
  const operation = current.activation?.operation;
  if (!operation) {
    throw new Error("Immutable pointer publication requires its activation operation.");
  }
  const generation = operation[target];
  assertImmutableInstallRecordCurrent(current, assertCurrent);
  if (current.descriptor.current.sha === generation.sha) {
    return current;
  }
  const root = current.descriptor.root;
  const temporary = path.join(root, `.openclaw-current-${operation.operationId}`);
  const assertTarget = () => {
    if (
      directoryIdentity(generation.path) !== generation.identity ||
      fs.realpathSync(generation.path) !== generation.path
    ) {
      throw new Error("Immutable target generation changed; current was not modified.");
    }
  };
  assertTarget();
  assertImmutableDescriptorCurrent(current.descriptor);
  let intent = operation.pointerIntent;
  if (!intent) {
    // A crash can leave this operation's link before its intent commits.
    // Reuse only its exact target; an unrelated object remains untouched.
    const existing = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
    if (!existing) {
      fs.symlinkSync(`releases/${generation.sha}`, temporary);
    } else if (
      !existing.isSymbolicLink() ||
      existing.uid !== 0n ||
      fs.readlinkSync(temporary) !== `releases/${generation.sha}`
    ) {
      throw new Error(
        "Immutable temporary pointer differs from this operation; recovery retained.",
      );
    }
    requireDirectorySync(syncDirectorySync(root), "Immutable pointer preparation");
    const stat = fs.lstatSync(temporary, { bigint: true });
    intent = {
      identityEncoding: "exact",
      fromIdentity: current.descriptor.current.pointerIdentity,
      targetSha: generation.sha,
      temporaryIdentity: `${stat.dev}:${stat.ino}`,
    };
    current = updateImmutableInstallRecord(
      current,
      {
        ...current,
        activation: { ...current.activation, operation: { ...operation, pointerIntent: intent } },
      },
      assertCurrent,
    );
  }
  const stat = fs.lstatSync(temporary, { bigint: true });
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    `${stat.dev}:${stat.ino}` !== intent.temporaryIdentity ||
    intent.targetSha !== generation.sha ||
    fs.readlinkSync(temporary) !== `releases/${generation.sha}`
  ) {
    throw new Error("Immutable temporary pointer identity changed; recovery retained.");
  }
  assertImmutableInstallRecordCurrent(current, assertCurrent);
  assertImmutableDescriptorCurrent(current.descriptor);
  assertTarget();
  fs.renameSync(temporary, path.join(root, "current"));
  return reconcileImmutablePointer(current, assertCurrent);
}
