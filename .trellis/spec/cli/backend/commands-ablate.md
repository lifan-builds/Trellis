# `trellis ablate` and `trellis restore`

Sources:

- `packages/cli/src/commands/ablate.ts`
- `packages/cli/src/utils/ablation-store.ts`
- `packages/cli/src/utils/managed-removal.ts`

These commands temporarily subtract every supported project-owned Trellis
activation surface and later restore the exact pre-ablation state. The first
public scope is full-only: capability selection and release baselines are not
supported.

## Command contract

```text
trellis ablate [--dry-run] [-y|--yes]
trellis restore [--dry-run] [-y|--yes]
```

- `--dry-run` performs planning and conflict checks without project or state
  mutation.
- `--yes` skips confirmation. A non-TTY mutation without `--yes` fails closed.
- Repeated `ablate` never stacks transactions; it directs the user to restore.
- Missing install prints `Trellis is not installed in this project.` and exits
  with status 0 without writes. Missing state and repeated successful restore
  print `No Trellis ablation transaction exists for this project.` and also
  exit 0 without writes.
- Successful ablate/restore tells the user to start a fresh agent session.

This differs from:

- `trellis uninstall`: permanent, best-effort removal with no recovery state;
- `TRELLIS_HOOKS=0`: disables supported hooks only, leaving skills, agents,
  commands, specs, workflow, and memory present;
- `no-trellis`: a prompt convention, not filesystem subtraction;
- a benchmark runner: ablation does not create worktrees, launch agents,
  dispatch prompts, score results, hide Git changes, or downgrade releases.

## Ownership boundary

The v2 `.trellis/.template-hashes.json` manifest remains authoritative. Before
planning, the command calls `getConfiguredPlatforms()` unchanged and prunes
orphan manifest keys in memory. The one structured-file registry in
`utils/managed-removal.ts` is shared with uninstall and dispatches the existing
scrubbers for mixed JSON, TOML, and Markdown files.

Full ablation removes/scrubs:

1. every current manifest-owned platform file;
2. only Trellis fields/blocks in registered mixed files;
3. the visible `.trellis/` path, including tasks/specs/workspace state;
4. managed directories proven empty after planned deletions.

Files outside the pruned manifest and non-Trellis mixed-file content are not
owned and must remain untouched. A malformed mixed file that cannot be proven
scrubbed makes ablation fail before backup or mutation.

## External transaction

Default location:

```text
~/.trellis/ablations/v1/<sha256-canonical-project-root>/
  state.json
  backup/
```

Tests and isolated validation may set `TRELLIS_ABLATION_STATE_ROOT` to a path
outside the target project. A state root inside the project is rejected.
Transaction directories/state use restrictive POSIX permissions; the outer
`0700` directory protects exact backup objects whose original modes are kept
for restoration.

The strict v1 state records:

- status: `preparing | applied | restoring | conflict`;
- canonical project root plus full SHA-256 identity;
- CLI version and stable capability ID `trellis.full`;
- configured platforms and pruned manifest;
- each affected relative path, exact pre-fingerprint, expected ablated
  fingerprint, and backup path.

Fingerprints distinguish absent paths, files, directories, and symlinks. They
include byte/tree hashes, sizes, link targets, and relevant modes. Unknown,
malformed, cross-project, or unverifiable state fails closed.

## Recovery state validation contract

### 1. Scope / trigger

This contract applies whenever ablation creates or restore reads external
transaction state. It prevents a configured/symlinked state root or a tampered
`backupPath` from redirecting recovery I/O into the project or another object in
the transaction.

### 2. Signatures

- `stageAblationTransaction(input) -> LoadedAblationTransaction`
- `loadAblationTransaction(projectRoot) -> LoadedAblationTransaction | null`
- `parseAblationState(value) -> AblationStateV1`

### 3. Contracts

- `TRELLIS_ABLATION_STATE_ROOT`, including its nearest existing symlink
  ancestor, must resolve outside the canonical project on both stage and load.
  Validate this before creating or reading recovery objects.
- The in-memory preparing state must pass the same strict Zod schema and path
  validation as a reloaded `state.json` before any transaction directory is
  created.
- A non-absent entry's `backupPath` is exactly
  `backup/<entry.relativePath>`; absent entries have no backup path.
- State publication remains atomic only after every backup fingerprint verifies.

### 4. Validation and error matrix

| Condition | Result |
| --- | --- |
| State root resolves inside project | Refuse before project/recovery mutation |
| Unknown/extra/malformed state field | Strict parse error; no publication |
| Backup path differs from `backup/<relativePath>` | Parse/stage refusal |
| Non-absent entry has no backup | Parse/stage refusal |
| Absent entry claims a backup | Parse/stage refusal |
| Valid external state exists | Verify every backup, then allow restore preflight |

### 5. Good / base / bad cases

- Good: `/tmp/trellis-state/<project-key>/backup/.trellis` for entry
  `.trellis`.
- Base: no external transaction exists; restore is a friendly no-op after the
  external-root boundary is validated.
- Bad: an external-looking symlink ancestor resolves into the project, or entry
  `AGENTS.md` points at `backup/.trellis`; both fail closed.

### 6. Tests required

- Unit: inside-project and symlink-ancestor roots fail without creating the
  configured state directory.
- Unit: invalid in-memory fingerprints fail strict schema validation before
  recovery storage exists.
- Unit: mismatched, missing, and unexpected backup paths fail parsing.
- Integration: valid stage/apply/restore and interrupted-operation recovery
  continue to pass.

### 7. Wrong vs correct

```ts
// Wrong: only check the state root while staging, and trust persisted paths.
const source = path.join(transactionDir, entry.backupPath);

// Correct: validate the root on stage and load, then require an exact mapping.
assertExternalStateRoot(projectRoot, stateRoot);
if (entry.backupPath !== `backup/${entry.relativePath}`) throw new Error(...);
```

## Path and symlink safety

Every manifest/state path is validated before joining:

- POSIX relative paths only;
- no absolute, empty, `.`, `..`, NUL, or backslash segment;
- lexical containment under the canonical project root;
- `lstat` semantics for every affected leaf;
- parent symlinks must resolve inside the project;
- leaf symlinks are opaque links and are never dereferenced;
- unsupported filesystem object types and manifest-owned directories fail
  closed.

The `.trellis` leaf may itself be a symlink; backup/restoration preserves the
link rather than copying its target.

## Ablate transaction

1. Validate cwd/install/v2 manifest and reject an existing transaction.
2. Build the shared strict removal plan and predict empty managed directories.
3. Render the plan; dry-run exits here.
4. Copy exact affected paths into a temporary external transaction and verify
   every backup fingerprint.
5. Write strict `preparing` state atomically, then rename the complete
   transaction into place before the first project mutation.
6. Atomically rewrite mixed files, unlink opaque leaves, remove `.trellis`,
   and prune predicted empty managed directories.
7. Verify every expected ablated fingerprint, then atomically mark `applied`.
8. On apply/verification failure, attempt exact rollback. Delete recovery state
   only after verified rollback; otherwise retain a `preparing`/`restoring`
   status so a retry can safely accept paths already at either exact endpoint.

The command never stages, commits, or hides Git changes.

## Restore transaction

1. Strictly load state for the canonical current project.
2. Compare **all** affected paths before the first project write.
3. Any mismatch reports `conflict` and restores zero paths. Preserve a
   `preparing`/`restoring` status when it supplies the endpoint relaxation;
   otherwise persist `conflict`.
4. A `preparing` or `restoring` crash record accepts paths already matching
   either pre-state or expected ablated state, enabling interrupted-operation
   recovery without accepting unrelated content.
5. Mark `restoring`, copy backup paths without dereferencing links, restore
   exact modes, and verify every pre-fingerprint.
6. Delete the external transaction only after complete verification.

PR 1 performs no three-way merge. Users resolve a conflict by returning the
reported path to its expected ablated state and rerunning `trellis restore`.

## Privacy and session boundary

The transaction contains exact `.trellis/` task/spec/workspace bytes because
they are required for recovery. Those user-authored files may themselves
contain prompts, responses, credentials, or other sensitive text; the CLI
discloses this before mutation, stores the transaction under a private state
root, and retains it only until verified restore. Ablation does not separately
collect browser/session state, global channel logs, host transcripts, or
unrelated application files.

The current agent may already have Trellis instructions in context, so ablation
does not change that live session. Meaningful comparison begins in a fresh
session. Global Trellis CLI data remains installed and explicitly callable.

## Required tests

- v1 schema/project identity/state permission and corruption rejection;
- file/directory/symlink fingerprints and non-dereferencing backup;
- invalid manifest paths and external parent-symlink refusal;
- exact init → ablate → restore round trip with user neighbors;
- dry-run, cancel, non-TTY, no-install/state, repeated commands;
- interrupted `preparing` recovery and apply rollback;
- all-path restore conflict with zero project writes;
- complete existing uninstall scrubber/integration/dirty/over-delete suites.
