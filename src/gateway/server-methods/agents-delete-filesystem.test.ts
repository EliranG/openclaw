import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  AgentCleanupIdentityMismatchError,
  prepareAgentDeleteCleanupPaths,
  statAgentCleanupPath,
} from "./agents-delete-filesystem.js";

const native = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("../../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/fs-safe.js")>()),
  root: async (rootReal: string) => ({ rootReal, stat: native.stat }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("retains exact cleanup identity above 2^53 and refuses a neighboring file ID", async () => {
  const directory = tempDirs.make("openclaw-agent-cleanup-identity-");
  const file = path.join(directory, "owned");
  await fs.writeFile(file, "owned");
  const actual = await fs.lstat(file, { bigint: true });
  const exactIdentity = { dev: actual.dev, ino: 9_007_199_254_740_992n };
  vi.spyOn(fs, "lstat").mockResolvedValue(Object.assign(actual, exactIdentity));
  const [prepared] = await prepareAgentDeleteCleanupPaths([file]);
  expect(prepared?.preparedIdentity).toEqual({
    dev: exactIdentity.dev.toString(),
    ino: "9007199254740992",
  });
  native.stat.mockResolvedValue({
    isSymbolicLink: false,
    isFile: true,
    nlink: 1,
    dev: Number(exactIdentity.dev),
    ino: Number(exactIdentity.ino),
    exactIdentity,
  });
  await expect(statAgentCleanupPath(prepared!)).resolves.toBeUndefined();
  // These neighboring IDs collapse to the same JS number.
  expect(Number(exactIdentity.ino + 1n)).toBe(Number(exactIdentity.ino));
  native.stat.mockResolvedValue({
    isSymbolicLink: false,
    isFile: true,
    nlink: 1,
    dev: Number(exactIdentity.dev),
    ino: Number(exactIdentity.ino + 1n),
    exactIdentity: { ...exactIdentity, ino: exactIdentity.ino + 1n },
  });
  await expect(statAgentCleanupPath(prepared!)).rejects.toBeInstanceOf(
    AgentCleanupIdentityMismatchError,
  );
});

it("reads cleanup paths from released numeric journals", async () => {
  const directory = tempDirs.make("openclaw-agent-cleanup-legacy-");
  const [prepared] = await prepareAgentDeleteCleanupPaths(
    [],
    [
      {
        path: directory,
        canonicalPath: directory,
        parentPath: path.dirname(directory),
        kind: "target",
        sourcePaths: [directory],
        dev: 42,
        ino: 123,
        coversDescendants: true,
        done: false,
      },
    ],
  );
  expect(prepared?.preparedIdentity).toEqual({ dev: "42", ino: "123" });
});
