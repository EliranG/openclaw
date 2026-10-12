import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["unchanged", "contents", "identity"] as const)(
  "preserves quarantine bytes across cross-device archival (changed=%s)",
  async (changed) => {
    const filePath = path.join(tempDirs.make("cron-quarantine-archive-"), "jobs-quarantine.json");
    const source = '{"version":1,"jobs":[{"reason":"invalid-schedule","raw":"preserve"}]}';
    const archivePath = `${filePath}.migrated.2`;
    const sourceMtime = new Date("2026-07-02T03:04:05.000Z");
    await fs.writeFile(filePath, source);
    await fs.writeFile(`${filePath}.migrated`, "earlier archive");
    await fs.chmod(filePath, 0o640);
    await fs.utimes(filePath, sourceMtime, sourceMtime);
    const stat = fs.stat.bind(fs);
    const originalIdentity = await stat(filePath, { bigint: true });
    // Adjacent IDs collapse to the same numeric Stats inode on Windows.
    const largeInode = 2n ** 53n + 3n;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const observed = await stat(...args);
      if (observed && args[0] === filePath) {
        const unchanged =
          typeof observed.ino === "bigint"
            ? observed.ino === originalIdentity.ino
            : observed.ino === Number(originalIdentity.ino);
        const inode = unchanged ? largeInode : largeInode + 1n;
        observed.ino = typeof observed.ino === "bigint" ? inode : Number(inode);
      }
      return observed;
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("cross-device rename"), { code: "EXDEV" }),
    );
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode);
      if (changed === "contents") {
        await fs.writeFile(filePath, "new operator bytes");
      } else if (changed === "identity") {
        const replacementPath = `${filePath}.replacement`;
        await fs.writeFile(replacementPath, source);
        await rename(replacementPath, filePath);
      }
    });
    const result = await archiveLegacyCronFile(
      filePath,
      createHash("sha256").update(source).digest("hex"),
    );
    expect(await fs.readFile(`${filePath}.migrated`, "utf8")).toBe("earlier archive");
    if (changed !== "unchanged") {
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("changed during archival"),
      });
      expect(await fs.readFile(filePath, "utf8")).toBe(
        changed === "contents" ? "new operator bytes" : source,
      );
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result).toEqual({ ok: true, archivePath });
      expect(await fs.readFile(archivePath, "utf8")).toBe(source);
      const stat = await fs.stat(archivePath);
      expect(stat.mtimeMs).toBe(sourceMtime.getTime());
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o640);
      }
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
