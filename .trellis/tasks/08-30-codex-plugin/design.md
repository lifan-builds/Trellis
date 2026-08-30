# Technical design

## Boundaries

The new companion plugin lives under `plugins/codex/`. It contains only the
Codex manifest, hook registration, a small Node.js dispatcher, and user-facing
documentation. The existing CLI templates remain unchanged and continue to
write `.codex/hooks.json` and `.codex/hooks/*.py` during `trellis init` and
`trellis update`.

## Data flow

1. Codex loads `plugins/codex/.codex-plugin/plugin.json` and the referenced
   `hooks/codex-hooks.json`.
2. After the user reviews the plugin hooks, Codex invokes the dispatcher for
   `UserPromptSubmit` or a matching `SubagentStart` event.
3. The dispatcher reads the Codex event payload once, resolves the project directory from
   the payload's `cwd` (falling back to the process cwd), and walks upward until
   it finds `.trellis/`.
4. If no Trellis root or generated target hook exists, it exits 0 with no
   output. Otherwise it runs the corresponding repository-local Python hook
   with the original JSON payload on stdin and forwards stdout/stderr and the
   exit status.

This keeps workflow state, task/session resolution, specs, and skills in the
repository where Trellis already manages them. The plugin owns only stable
hook wiring and dispatch.

## Compatibility and rollout

- The project-local `.codex/hooks.json` path remains supported and is not
  removed or changed. Users can adopt the plugin incrementally, and users on
  Codex surfaces without plugin support retain today's behavior.
- The plugin hooks use `PLUGIN_ROOT` in their commands, with the documented
  `CLAUDE_PLUGIN_ROOT` compatibility fallback for hosts that expose the legacy
  variable.
- The plugin does not enable Codex features, change sandbox policy, or bypass
  approval for tools and commands outside the registered hook definitions.

## Failure handling

The dispatcher is fail-open for unrelated projects and fail-closed for missing
local integration: discovery failures, malformed hook input, missing Python,
or missing generated files produce no context and a successful exit. A local
hook's own output and exit status are preserved when it can be executed.

## Testing

Static tests validate the manifest and hook event structure. Dispatcher tests
exercise a temporary Trellis root with a stub local hook, a non-Trellis
directory, and a missing local hook. Existing CLI tests remain the regression
coverage for project-local generation and update behavior.
