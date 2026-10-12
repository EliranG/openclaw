import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { legacyAuditFileIdentitiesMatch } from "./state-migrations.audit-checkpoints.js";
import {
  parseAuditRecoveryRestoreJournal,
  serializeAuditRecoveryRestoreJournal,
} from "./state-migrations.audit-recovery-protocol.js";
import { restoreInterruptedAuditRecoveryArchive } from "./state-migrations.audit-recovery.js";

const sourceRaw = Buffer.from("legacy audit row\n");
const scrubPattern = Buffer.from(" \t".repeat(16));

describe("legacy audit recovery identity persistence", () => {
  const directories = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    }),
  );

  it.each([false, true])(
    "recovers a released numeric restore journal without modifying a replacement (replaced=%s)",
    async (replaced) => {
      const directory = directories.make("legacy-audit-restore-");
      const relativePath = "config-audit.jsonl.migrated.raw";
      const file = path.join(directory, relativePath);
      const restorePath = `${file}.doctor-scrub-restore`;
      const progressPath = `${file}.doctor-scrub-progress`;
      await fs.writeFile(file, sourceRaw, { mode: 0o600 });
      const identity = await fs.stat(file);
      expect(Number.isSafeInteger(identity.dev)).toBe(true);
      expect(Number.isSafeInteger(identity.ino)).toBe(true);
      // This is the v2026.10.2 writer's schema, independent of today's serializer.
      const journal = `${JSON.stringify({
        schemaVersion: 6,
        rawBase64: sourceRaw.toString("base64"),
        scrubPatternBase64: scrubPattern.toString("base64"),
        target: { dev: identity.dev, ino: identity.ino, size: sourceRaw.length },
      })}\n`;
      await fs.writeFile(restorePath, journal, { mode: 0o600 });
      await fs.writeFile(
        progressPath,
        JSON.stringify({
          schemaVersion: 1,
          journalHash: createHash("sha256").update(journal).digest("hex"),
          direction: "scrubbing",
          committedBytes: sourceRaw.length,
          pendingEnd: sourceRaw.length,
          extentBytes: sourceRaw.length,
        }),
        { mode: 0o600 },
      );
      const scrubbed = Buffer.alloc(sourceRaw.length, scrubPattern);
      await fs.writeFile(file, scrubbed);
      if (replaced) {
        await fs.rename(file, `${file}.original`);
        await fs.writeFile(file, scrubbed, { mode: 0o600 });
      }
      const warnings: string[] = [];
      expect(
        await restoreInterruptedAuditRecoveryArchive({
          root: await root(directory),
          relativePath,
          label: "config audit log",
          warnings,
        }),
      ).toBe(!replaced);
      if (replaced) {
        expect(warnings.join("\n")).toContain("no longer matches its restore journal target");
        expect(await fs.readFile(file)).toEqual(scrubbed);
        expect(await fs.readFile(restorePath, "utf8")).toBe(journal);
      } else {
        expect(warnings).toEqual([]);
        expect(await fs.readFile(file)).toEqual(sourceRaw);
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(progressPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("round-trips adjacent Windows file IDs above the numeric precision limit", () => {
    const target = { dev: "4", ino: "9007199254740993", size: sourceRaw.length };
    const raw = serializeAuditRecoveryRestoreJournal({ rawBytes: sourceRaw, scrubPattern, target });
    const journal = parseAuditRecoveryRestoreJournal(raw);
    expect(journal.target).toEqual(target);
    expect(legacyAuditFileIdentitiesMatch(journal.target, target)).toBe(true);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: "9007199254740992" }),
    ).toBe(false);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: 9_007_199_254_740_992 }),
    ).toBe(false);
  });

  it("refuses an already-rounded numeric restore identity", () => {
    expect(() =>
      parseAuditRecoveryRestoreJournal(
        JSON.stringify({
          schemaVersion: 6,
          rawBase64: sourceRaw.toString("base64"),
          scrubPatternBase64: scrubPattern.toString("base64"),
          target: { dev: 4, ino: 9_007_199_254_740_992, size: sourceRaw.length },
        }),
      ),
    ).toThrow("invalid legacy audit recovery restore journal");
  });
});
