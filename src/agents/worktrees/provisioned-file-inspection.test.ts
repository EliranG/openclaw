import type { BigIntStats, Stats } from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  captureParentDirectoryIdentities,
  validateDirectoryIdentities,
} from "./provisioned-file-inspection.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("accepts unchanged large parent IDs and rejects a replacement with the same rounded ID", async () => {
  const root = roots.make("worktree-parent-identity-");
  const lstat = fs.lstat.bind(fs);
  let inode = 9_007_199_254_740_992n;
  const project = <T extends Stats | BigIntStats>(stat: T): T => {
    Object.defineProperty(stat, "ino", {
      value: typeof stat.ino === "bigint" ? inode : Number(inode),
    });
    return stat;
  };
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => project(await lstat(...args)));

  const parents = await captureParentDirectoryIdentities(root, "settings.local");
  await expect(validateDirectoryIdentities(parents)).resolves.toBeUndefined();

  // Windows file IDs can differ even when a JS number rounds them to the same value.
  expect(Number(inode + 1n)).toBe(Number(inode));
  inode += 1n;
  await expect(validateDirectoryIdentities(parents)).rejects.toThrow(
    "provisioned parent directory changed",
  );
});
