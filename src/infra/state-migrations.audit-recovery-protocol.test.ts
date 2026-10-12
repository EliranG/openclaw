import { describe, expect, it } from "vitest";
import { legacyAuditFileIdentitiesMatch } from "./state-migrations.audit-checkpoints.js";
import {
  parseAuditRecoveryRestoreJournal,
  serializeAuditRecoveryRestoreJournal,
} from "./state-migrations.audit-recovery-protocol.js";

const sourceRaw = Buffer.from("legacy audit row\n");
const scrubPattern = Buffer.from(" \t".repeat(16));

describe("legacy audit recovery identity persistence", () => {
  it("reads the released numeric restore-journal format", () => {
    const journal = parseAuditRecoveryRestoreJournal(
      JSON.stringify({
        schemaVersion: 6,
        rawBase64: sourceRaw.toString("base64"),
        scrubPatternBase64: scrubPattern.toString("base64"),
        target: { dev: 4, ino: 17, size: sourceRaw.length },
      }),
    );
    expect(journal.sourceRaw).toEqual(sourceRaw);
    expect(journal.target).toEqual({ dev: "4", ino: "17", size: sourceRaw.length });
    expect(legacyAuditFileIdentitiesMatch(journal.target, { dev: 4, ino: 17 })).toBe(true);
  });

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
