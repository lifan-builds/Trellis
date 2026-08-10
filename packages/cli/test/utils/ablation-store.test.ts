import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ABLATION_SCHEMA_VERSION,
  ABLATION_STATE_ROOT_ENV,
  AblationConflictError,
  deleteAblationTransaction,
  expectedFileFingerprint,
  fingerprintPath,
  fingerprintsEqual,
  loadAblationTransaction,
  parseAblationState,
  projectKey,
  restoreAblationTransaction,
  stageAblationTransaction,
  transitionAblationState,
  verifyAblatedState,
  verifyRestoredState,
  type AblationEntry,
  type LoadedAblationTransaction,
} from "../../src/utils/ablation-store.js";

describe("ablation-store", () => {
  let tmpDir: string;
  let projectDir: string;
  let stateRoot: string;
  let originalStateRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ablation-store-"));
    projectDir = path.join(tmpDir, "project");
    stateRoot = path.join(tmpDir, "state");
    fs.mkdirSync(path.join(projectDir, ".trellis"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "managed.txt"), "managed\n");
    fs.writeFileSync(
      path.join(projectDir, ".trellis", "config.yaml"),
      "version: 1\n",
    );
    originalStateRoot = process.env[ABLATION_STATE_ROOT_ENV];
    process.env[ABLATION_STATE_ROOT_ENV] = stateRoot;
  });

  afterEach(() => {
    if (originalStateRoot === undefined) {
      Reflect.deleteProperty(process.env, ABLATION_STATE_ROOT_ENV);
    } else {
      process.env[ABLATION_STATE_ROOT_ENV] = originalStateRoot;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function entries(): AblationEntry[] {
    return [
      {
        relativePath: "managed.txt",
        pre: fingerprintPath(path.join(projectDir, "managed.txt")),
        expectedAblated: { kind: "absent" },
        backupPath: "backup/managed.txt",
      },
      {
        relativePath: ".trellis",
        pre: fingerprintPath(path.join(projectDir, ".trellis")),
        expectedAblated: { kind: "absent" },
        backupPath: "backup/.trellis",
      },
    ];
  }

  function stage(): LoadedAblationTransaction {
    return stageAblationTransaction({
      projectRoot: projectDir,
      configuredPlatforms: ["codex"],
      manifest: { "managed.txt": "abc" },
      entries: entries(),
    });
  }

  function removeManagedState(): void {
    fs.rmSync(path.join(projectDir, "managed.txt"), { force: true });
    fs.rmSync(path.join(projectDir, ".trellis"), {
      recursive: true,
      force: true,
    });
  }

  it("derives a stable full-width project identity", () => {
    const key = projectKey(projectDir);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(projectKey(projectDir)).toBe(key);

    const other = path.join(tmpDir, "other");
    fs.mkdirSync(other);
    expect(projectKey(other)).not.toBe(key);
  });

  it("fingerprints files, directories, and symlinks without dereferencing", () => {
    const file = fingerprintPath(path.join(projectDir, "managed.txt"));
    const dir = fingerprintPath(path.join(projectDir, ".trellis"));
    expect(file.kind).toBe("file");
    expect(dir.kind).toBe("directory");

    if (process.platform !== "win32") {
      const link = path.join(projectDir, "managed-link");
      fs.symlinkSync("managed.txt", link);
      expect(fingerprintPath(link)).toMatchObject({
        kind: "symlink",
        target: "managed.txt",
      });
    }
  });

  it("computes the exact expected fingerprint for an atomic mixed-file write", () => {
    const expected = expectedFileFingerprint("after\n", 0o640);
    const target = path.join(projectDir, "after.txt");
    fs.writeFileSync(target, "after\n");
    if (process.platform !== "win32") fs.chmodSync(target, 0o640);
    const actual = fingerprintPath(target);
    if (process.platform === "win32" && actual.kind === "file") {
      expect(actual.sha256).toBe(expected.sha256);
      expect(actual.size).toBe(expected.size);
    } else {
      expect(fingerprintsEqual(actual, expected)).toBe(true);
    }
  });

  it("rejects unknown, malformed, and non-strict state schemas", () => {
    expect(() => parseAblationState({ schemaVersion: 99 })).toThrow();
    expect(() =>
      parseAblationState({
        schemaVersion: ABLATION_SCHEMA_VERSION,
        status: "applied",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("requires each backup path to match backup/<relativePath>", () => {
    const transaction = stage();
    const invalid = {
      ...transaction.state,
      entries: transaction.state.entries.map((entry, index) =>
        index === 0 ? { ...entry, backupPath: "backup/.trellis" } : entry,
      ),
    };

    expect(() => parseAblationState(invalid)).toThrow(
      /backup path does not match/,
    );
  });

  it("strictly validates staged state before creating recovery storage", () => {
    const invalidEntries = entries();
    invalidEntries[0] = {
      ...invalidEntries[0],
      expectedAblated: {
        kind: "file",
        sha256: "not-a-sha256",
        size: 0,
        mode: 0,
      },
    };

    expect(() =>
      stageAblationTransaction({
        projectRoot: projectDir,
        configuredPlatforms: ["codex"],
        manifest: { "managed.txt": "abc" },
        entries: invalidEntries,
      }),
    ).toThrow();
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  it("publishes a verified preparing transaction before mutation", () => {
    const transaction = stage();
    expect(transaction.state.status).toBe("preparing");
    expect(fs.existsSync(transaction.paths.stateFile)).toBe(true);
    expect(loadAblationTransaction(projectDir)?.state.projectRoot).toBe(
      fs.realpathSync(projectDir),
    );

    if (process.platform !== "win32") {
      expect(fs.statSync(transaction.paths.transactionDir).mode & 0o777).toBe(
        0o700,
      );
      expect(fs.statSync(transaction.paths.stateFile).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a recovery root inside the project", () => {
    process.env[ABLATION_STATE_ROOT_ENV] = path.join(projectDir, "recovery");
    expect(() => stage()).toThrow(/must point outside the project/);
    expect(fs.existsSync(path.join(projectDir, "recovery"))).toBe(false);
    expect(() => loadAblationTransaction(projectDir)).toThrow(
      /must point outside the project/,
    );

    if (process.platform !== "win32") {
      const stateLink = path.join(tmpDir, "state-link");
      fs.symlinkSync(projectDir, stateLink, "dir");
      process.env[ABLATION_STATE_ROOT_ENV] = path.join(stateLink, "recovery");
      expect(() => loadAblationTransaction(projectDir)).toThrow(
        /must point outside the project/,
      );
    }
  });

  it("restores exact state and allows deleting the transaction only afterwards", () => {
    const beforeManaged = fingerprintPath(path.join(projectDir, "managed.txt"));
    const beforeTrellis = fingerprintPath(path.join(projectDir, ".trellis"));
    const transaction = stage();
    removeManagedState();
    transitionAblationState(transaction, "applied");
    verifyAblatedState(transaction);

    restoreAblationTransaction(transaction);
    verifyRestoredState(transaction);
    expect(
      fingerprintsEqual(
        fingerprintPath(path.join(projectDir, "managed.txt")),
        beforeManaged,
      ),
    ).toBe(true);
    expect(
      fingerprintsEqual(
        fingerprintPath(path.join(projectDir, ".trellis")),
        beforeTrellis,
      ),
    ).toBe(true);

    deleteAblationTransaction(transaction);
    expect(fs.existsSync(transaction.paths.transactionDir)).toBe(false);
  });

  it("recovers a preparing transaction after a partially applied mutation", () => {
    const transaction = stage();
    fs.rmSync(path.join(projectDir, "managed.txt"));

    restoreAblationTransaction(transaction);
    verifyRestoredState(transaction);
    expect(fs.readFileSync(path.join(projectDir, "managed.txt"), "utf-8")).toBe(
      "managed\n",
    );
  });

  it("reports all conflicts and performs zero project writes", () => {
    const transaction = stage();
    removeManagedState();
    transitionAblationState(transaction, "applied");
    fs.writeFileSync(path.join(projectDir, "managed.txt"), "user edit\n");

    expect(() => restoreAblationTransaction(transaction)).toThrow(
      AblationConflictError,
    );
    expect(transaction.state.status).toBe("conflict");
    expect(fs.readFileSync(path.join(projectDir, "managed.txt"), "utf-8")).toBe(
      "user edit\n",
    );
    expect(fs.existsSync(path.join(projectDir, ".trellis"))).toBe(false);
  });
});
