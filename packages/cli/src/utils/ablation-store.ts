/**
 * External, versioned recovery storage for reversible full Trellis ablation.
 *
 * The store intentionally contains only Trellis-owned project paths and the
 * `.trellis/` tree. It never reads or records prompts, agent transcripts,
 * channel logs, credentials, or unrelated application files.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { VERSION } from "../constants/version.js";
import { writeFileAtomic } from "./atomic-write.js";
import {
  assertSafeManagedPath,
  lstatIfPresent,
  validateManagedRelativePath,
} from "./managed-removal.js";

export const ABLATION_SCHEMA_VERSION = 1;
export const FULL_ABLATION_CAPABILITY = "trellis.full" as const;
export const ABLATION_STATE_ROOT_ENV = "TRELLIS_ABLATION_STATE_ROOT";

export type AblationStatus = "preparing" | "applied" | "restoring" | "conflict";

export interface AbsentFingerprint {
  kind: "absent";
}

export interface FileFingerprint {
  kind: "file";
  sha256: string;
  size: number;
  mode: number;
}

export interface DirectoryFingerprint {
  kind: "directory";
  sha256: string;
  mode: number;
}

export interface SymlinkFingerprint {
  kind: "symlink";
  target: string;
  mode: number;
}

export type PathFingerprint =
  | AbsentFingerprint
  | FileFingerprint
  | DirectoryFingerprint
  | SymlinkFingerprint;

export interface AblationEntry {
  relativePath: string;
  pre: PathFingerprint;
  expectedAblated: PathFingerprint;
  backupPath?: string;
}

export interface AblationStateV1 {
  schemaVersion: 1;
  status: AblationStatus;
  projectRoot: string;
  projectKey: string;
  trellisVersion: string;
  capabilities: [typeof FULL_ABLATION_CAPABILITY];
  createdAt: string;
  configuredPlatforms: string[];
  manifest: Record<string, string>;
  entries: AblationEntry[];
}

export interface TransactionPaths {
  stateRoot: string;
  transactionDir: string;
  stateFile: string;
  backupDir: string;
}

export interface StagedAblationInput {
  projectRoot: string;
  configuredPlatforms: readonly string[];
  manifest: Record<string, string>;
  entries: AblationEntry[];
}

export interface LoadedAblationTransaction {
  paths: TransactionPaths;
  state: AblationStateV1;
}

export interface AblationConflict {
  relativePath: string;
  expected: PathFingerprint;
  actual: PathFingerprint;
}

export class AblationConflictError extends Error {
  public readonly conflicts: AblationConflict[];

  public constructor(conflicts: AblationConflict[]) {
    super(
      `Restore refused because ${conflicts.length} Trellis-managed path(s) changed while ablated.`,
    );
    this.name = "AblationConflictError";
    this.conflicts = conflicts;
  }
}

const fingerprintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z
    .object({
      kind: z.literal("file"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().nonnegative(),
      mode: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("symlink"),
      target: z.string(),
      mode: z.number().int().nonnegative(),
    })
    .strict(),
]);

const ablationEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    pre: fingerprintSchema,
    expectedAblated: fingerprintSchema,
    backupPath: z.string().min(1).optional(),
  })
  .strict();

const ablationStateSchema = z
  .object({
    schemaVersion: z.literal(ABLATION_SCHEMA_VERSION),
    status: z.enum(["preparing", "applied", "restoring", "conflict"]),
    projectRoot: z.string().min(1),
    projectKey: z.string().regex(/^[a-f0-9]{64}$/),
    trellisVersion: z.string().min(1),
    capabilities: z.tuple([z.literal(FULL_ABLATION_CAPABILITY)]),
    createdAt: z.string().datetime(),
    configuredPlatforms: z.array(z.string()),
    manifest: z.record(z.string(), z.string()),
    entries: z.array(ablationEntrySchema).min(1),
  })
  .strict();

function modeBits(stat: fs.Stats): number {
  return process.platform === "win32" ? 0 : stat.mode & 0o7777;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashDirectory(absPath: string): string {
  const hash = createHash("sha256");
  const entries = fs
    .readdirSync(absPath)
    .sort((left, right) => left.localeCompare(right));

  for (const name of entries) {
    const child = path.join(absPath, name);
    const fingerprint = fingerprintPath(child);
    hash.update(name, "utf-8");
    hash.update("\0", "utf-8");
    hash.update(JSON.stringify(fingerprint), "utf-8");
    hash.update("\0", "utf-8");
  }

  return hash.digest("hex");
}

/** Fingerprint one path without dereferencing a symlink leaf. */
export function fingerprintPath(absPath: string): PathFingerprint {
  const stat = lstatIfPresent(absPath);
  if (!stat) return { kind: "absent" };

  if (stat.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: fs.readlinkSync(absPath),
      mode: modeBits(stat),
    };
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(absPath);
    return {
      kind: "file",
      sha256: sha256(content),
      size: content.byteLength,
      mode: modeBits(stat),
    };
  }
  if (stat.isDirectory()) {
    return {
      kind: "directory",
      sha256: hashDirectory(absPath),
      mode: modeBits(stat),
    };
  }

  throw new Error(
    `Unsupported filesystem object in ablation scope: ${absPath}`,
  );
}

export function expectedFileFingerprint(
  content: string | Uint8Array,
  mode: number,
): FileFingerprint {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return {
    kind: "file",
    sha256: sha256(bytes),
    size: bytes.byteLength,
    mode,
  };
}

export function fingerprintsEqual(
  left: PathFingerprint,
  right: PathFingerprint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function canonicalProjectRoot(cwd: string): string {
  return fs.realpathSync(cwd);
}

export function projectKey(projectRoot: string): string {
  return sha256(canonicalProjectRoot(projectRoot));
}

export function getAblationStateRoot(): string {
  const override = process.env[ABLATION_STATE_ROOT_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".trellis", "ablations", "v1");
}

export function getTransactionPaths(projectRoot: string): TransactionPaths {
  const canonical = canonicalProjectRoot(projectRoot);
  const key = projectKey(canonical);
  const stateRoot = getAblationStateRoot();
  const transactionDir = path.join(stateRoot, key);
  return {
    stateRoot,
    transactionDir,
    stateFile: path.join(transactionDir, "state.json"),
    backupDir: path.join(transactionDir, "backup"),
  };
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function writeState(paths: TransactionPaths, state: AblationStateV1): void {
  writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  if (process.platform !== "win32") fs.chmodSync(paths.stateFile, 0o600);
}

function projectedCanonicalPath(absPath: string): string {
  let cursor = path.resolve(absPath);
  const missingSegments: string[] = [];

  while (!lstatIfPresent(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  const canonicalAncestor = fs.realpathSync(cursor);
  return path.resolve(canonicalAncestor, ...missingSegments);
}

function isWithinPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function assertExternalStateRoot(projectRoot: string, stateRoot: string): void {
  const projectedStateRoot = projectedCanonicalPath(stateRoot);
  if (isWithinPath(projectRoot, projectedStateRoot)) {
    throw new Error(
      `${ABLATION_STATE_ROOT_ENV} must point outside the project being ablated.`,
    );
  }
}

function validateStoredRelativePath(relativePath: string): void {
  validateManagedRelativePath(relativePath);
}

function copyPath(
  source: string,
  destination: string,
  privateParents: boolean,
): void {
  const stat = fs.lstatSync(source);
  if (privateParents) {
    ensurePrivateDirectory(path.dirname(destination));
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
  }

  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(destination, modeBits(stat));
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const child of fs.readdirSync(source)) {
      copyPath(
        path.join(source, child),
        path.join(destination, child),
        privateParents,
      );
    }
    if (process.platform !== "win32") fs.chmodSync(destination, modeBits(stat));
    return;
  }

  throw new Error(`Unsupported filesystem object in ablation scope: ${source}`);
}

function removePath(absPath: string): void {
  if (!lstatIfPresent(absPath)) return;
  fs.rmSync(absPath, { recursive: true, force: true });
}

function makeExternalTreeRemovable(absPath: string): void {
  const stat = lstatIfPresent(absPath);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (process.platform !== "win32") fs.chmodSync(absPath, 0o700);
    for (const child of fs.readdirSync(absPath)) {
      makeExternalTreeRemovable(path.join(absPath, child));
    }
  } else if (process.platform !== "win32") {
    fs.chmodSync(absPath, 0o600);
  }
}

function removeExternalTransactionDir(transactionDir: string): void {
  makeExternalTreeRemovable(transactionDir);
  fs.rmSync(transactionDir, { recursive: true, force: true });
}

function verifyBackupEntry(transactionDir: string, entry: AblationEntry): void {
  if (!entry.backupPath) return;
  const backupAbs = path.join(transactionDir, ...entry.backupPath.split("/"));
  const actual = fingerprintPath(backupAbs);
  if (!fingerprintsEqual(actual, entry.pre)) {
    throw new Error(`Backup verification failed for ${entry.relativePath}`);
  }
}

function validateStatePaths(state: AblationStateV1): void {
  const seen = new Set<string>();
  for (const key of Object.keys(state.manifest))
    validateManagedRelativePath(key);

  for (const entry of state.entries) {
    validateStoredRelativePath(entry.relativePath);
    if (seen.has(entry.relativePath)) {
      throw new Error(`Duplicate ablation entry: ${entry.relativePath}`);
    }
    seen.add(entry.relativePath);
    if (entry.backupPath) validateStoredRelativePath(entry.backupPath);
    if (entry.pre.kind === "absent" && entry.backupPath) {
      throw new Error(
        `Absent ablation entry has a backup: ${entry.relativePath}`,
      );
    }
    if (entry.pre.kind !== "absent" && !entry.backupPath) {
      throw new Error(
        `Ablation entry is missing its backup: ${entry.relativePath}`,
      );
    }
    if (
      entry.pre.kind !== "absent" &&
      entry.backupPath !== `backup/${entry.relativePath}`
    ) {
      throw new Error(
        `Ablation backup path does not match its project path: ${entry.relativePath}`,
      );
    }
  }
}

/** Parse and validate an external state file. Unknown schemas fail closed. */
export function parseAblationState(value: unknown): AblationStateV1 {
  const parsed = ablationStateSchema.parse(value) as AblationStateV1;
  validateStatePaths(parsed);
  return parsed;
}

/**
 * Stage and verify the complete backup, then atomically publish a `preparing`
 * transaction before the caller mutates the project.
 */
export function stageAblationTransaction(
  input: StagedAblationInput,
): LoadedAblationTransaction {
  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const paths = getTransactionPaths(projectRoot);
  assertExternalStateRoot(projectRoot, paths.stateRoot);
  if (lstatIfPresent(paths.transactionDir)) {
    throw new Error(
      "An ablation transaction already exists for this project. Run `trellis restore` first.",
    );
  }
  const state = parseAblationState({
    schemaVersion: ABLATION_SCHEMA_VERSION,
    status: "preparing",
    projectRoot,
    projectKey: projectKey(projectRoot),
    trellisVersion: VERSION,
    capabilities: [FULL_ABLATION_CAPABILITY],
    createdAt: new Date().toISOString(),
    configuredPlatforms: [...input.configuredPlatforms],
    manifest: { ...input.manifest },
    entries: input.entries
      .map((entry) => ({ ...entry }))
      .sort(
        (left, right) =>
          left.relativePath.split("/").length -
          right.relativePath.split("/").length,
      ),
  });

  ensurePrivateDirectory(paths.stateRoot);
  assertExternalStateRoot(projectRoot, paths.stateRoot);
  const tempDir = path.join(
    paths.stateRoot,
    `.${projectKey(projectRoot)}.${process.pid}.${Date.now()}.tmp`,
  );
  const tempPaths: TransactionPaths = {
    stateRoot: paths.stateRoot,
    transactionDir: tempDir,
    stateFile: path.join(tempDir, "state.json"),
    backupDir: path.join(tempDir, "backup"),
  };

  ensurePrivateDirectory(tempPaths.transactionDir);
  ensurePrivateDirectory(tempPaths.backupDir);

  try {
    for (const entry of state.entries) {
      const source = assertSafeManagedPath(projectRoot, entry.relativePath);
      const actualPre = fingerprintPath(source);
      if (!fingerprintsEqual(actualPre, entry.pre)) {
        throw new Error(
          `Project path changed during ablation preflight: ${entry.relativePath}`,
        );
      }
      if (!entry.backupPath) continue;
      const destination = path.join(
        tempPaths.transactionDir,
        ...entry.backupPath.split("/"),
      );
      if (!lstatIfPresent(destination)) copyPath(source, destination, true);
      verifyBackupEntry(tempPaths.transactionDir, entry);
    }
    writeState(tempPaths, state);
    fs.renameSync(tempPaths.transactionDir, paths.transactionDir);
  } catch (error) {
    removeExternalTransactionDir(tempPaths.transactionDir);
    throw error;
  }

  return { paths, state };
}

export function loadAblationTransaction(
  projectRoot: string,
): LoadedAblationTransaction | null {
  const canonical = canonicalProjectRoot(projectRoot);
  const paths = getTransactionPaths(canonical);
  assertExternalStateRoot(canonical, paths.stateRoot);
  if (!lstatIfPresent(paths.stateFile)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.stateFile, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(
      `Ablation state is unreadable; refusing to modify the project: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const state = parseAblationState(raw);
  if (
    state.projectRoot !== canonical ||
    state.projectKey !== projectKey(canonical)
  ) {
    throw new Error("Ablation state does not belong to this project.");
  }
  for (const entry of state.entries)
    verifyBackupEntry(paths.transactionDir, entry);
  return { paths, state };
}

export function transitionAblationState(
  transaction: LoadedAblationTransaction,
  status: AblationStatus,
): AblationStateV1 {
  const next: AblationStateV1 = { ...transaction.state, status };
  writeState(transaction.paths, next);
  transaction.state = next;
  return next;
}

function currentPathForEntry(
  projectRoot: string,
  entry: AblationEntry,
): string {
  return assertSafeManagedPath(projectRoot, entry.relativePath);
}

function mayAlreadyBeRestored(state: AblationStateV1): boolean {
  return state.status === "preparing" || state.status === "restoring";
}

/** Preflight every affected path before restore writes anything. */
export function collectRestoreConflicts(
  transaction: LoadedAblationTransaction,
): AblationConflict[] {
  const conflicts: AblationConflict[] = [];
  for (const entry of transaction.state.entries) {
    const current = fingerprintPath(
      currentPathForEntry(transaction.state.projectRoot, entry),
    );
    if (fingerprintsEqual(current, entry.expectedAblated)) continue;
    if (
      mayAlreadyBeRestored(transaction.state) &&
      fingerprintsEqual(current, entry.pre)
    ) {
      continue;
    }
    conflicts.push({
      relativePath: entry.relativePath,
      expected: entry.expectedAblated,
      actual: current,
    });
  }
  return conflicts;
}

function restoreEntry(
  transaction: LoadedAblationTransaction,
  entry: AblationEntry,
): void {
  const destination = currentPathForEntry(transaction.state.projectRoot, entry);
  if (fingerprintsEqual(fingerprintPath(destination), entry.pre)) return;
  if (entry.pre.kind === "absent") {
    removePath(destination);
    return;
  }
  if (!entry.backupPath) {
    throw new Error(`Missing backup path for ${entry.relativePath}`);
  }
  const source = path.join(
    transaction.paths.transactionDir,
    ...entry.backupPath.split("/"),
  );
  removePath(destination);
  copyPath(source, destination, false);
}

/** Restore exact backup bytes/link identity/modes without running preflight. */
export function restoreTransactionFiles(
  transaction: LoadedAblationTransaction,
): void {
  const ordered = [...transaction.state.entries].sort(
    (left, right) =>
      left.relativePath.split("/").length -
      right.relativePath.split("/").length,
  );
  for (const entry of ordered) restoreEntry(transaction, entry);
}

export function verifyRestoredState(
  transaction: LoadedAblationTransaction,
): void {
  for (const entry of transaction.state.entries) {
    const actual = fingerprintPath(
      currentPathForEntry(transaction.state.projectRoot, entry),
    );
    if (!fingerprintsEqual(actual, entry.pre)) {
      throw new Error(
        `Restored path verification failed: ${entry.relativePath}`,
      );
    }
  }
}

export function verifyAblatedState(
  transaction: LoadedAblationTransaction,
): void {
  for (const entry of transaction.state.entries) {
    const actual = fingerprintPath(
      currentPathForEntry(transaction.state.projectRoot, entry),
    );
    if (!fingerprintsEqual(actual, entry.expectedAblated)) {
      throw new Error(
        `Ablated path verification failed: ${entry.relativePath}`,
      );
    }
  }
}

/** Conflict-safe exact restore. Any mismatch causes zero project writes. */
export function restoreAblationTransaction(
  transaction: LoadedAblationTransaction,
): void {
  const conflicts = collectRestoreConflicts(transaction);
  if (conflicts.length > 0) {
    transitionAblationState(transaction, "conflict");
    throw new AblationConflictError(conflicts);
  }

  transitionAblationState(transaction, "restoring");
  restoreTransactionFiles(transaction);
  verifyRestoredState(transaction);
}

export function deleteAblationTransaction(
  transaction: LoadedAblationTransaction,
): void {
  removeExternalTransactionDir(transaction.paths.transactionDir);
}
