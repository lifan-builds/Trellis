# Implementation plan

1. Add `plugins/codex/.codex-plugin/plugin.json` with the companion plugin
   metadata and hook entrypoint.
2. Add `plugins/codex/hooks/codex-hooks.json` registering
   `UserPromptSubmit` and matcher-scoped `SubagentStart` hooks.
3. Implement the small cross-platform dispatcher and focused tests; keep all
   project-local hook behavior in the existing generated Python files.
4. Add plugin README and link the Codex platform documentation to the
   companion installation path, trust boundary, and fallback behavior.
5. Run plugin tests plus the CLI Codex template/configurator suites, then run
   package lint/typecheck and inspect the final diff.
6. Run `detect_changes()` (or document the unavailable GitNexus command) before
   committing, create a commit on `codex/593-codex-plugin`, and open a draft PR
   linked to issue #593 for maintainer feedback.

## Review gates

- Do not change existing configurator symbols unless the plugin-only path is
  insufficient; if changes become necessary, run GitNexus impact analysis first.
- Keep the PR explicitly draft/feedback-oriented until maintainers confirm the
  plugin distribution location and whether marketplace metadata belongs in this
  repository or a companion marketplace change.
