import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const pluginRoot = path.join(repoRoot, "plugins", "codex");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
const dispatcherPath = path.join(
  pluginRoot,
  "hooks",
  "trellis-codex-dispatch.cjs",
);
const bundledWorkflowHookPath = path.join(
  pluginRoot,
  "hooks",
  "runtime",
  "inject-workflow-state.py",
);
const bundledSubagentHookPath = path.join(
  pluginRoot,
  "hooks",
  "runtime",
  "inject-subagent-context.py",
);
const sharedWorkflowHookPath = path.join(
  repoRoot,
  "packages",
  "cli",
  "src",
  "templates",
  "shared-hooks",
  "inject-workflow-state.py",
);
const sharedSubagentHookPath = path.join(
  repoRoot,
  "packages",
  "cli",
  "src",
  "templates",
  "shared-hooks",
  "inject-subagent-context.py",
);

describe("Trellis Codex plugin", () => {
  it("declares the manifest and both supported hook events", () => {
    const manifest = JSON.parse(readText(manifestPath)) as {
      hooks?: string;
      name?: string;
    };
    const hooks = JSON.parse(readText(hooksPath)) as {
      hooks?: Record<string, unknown>;
    };

    expect(manifest.name).toBe("trellis");
    expect(manifest.hooks).toBeUndefined();
    expect(Object.keys(hooks.hooks ?? {}).sort()).toEqual([
      "SubagentStart",
      "UserPromptSubmit",
    ]);
  });

  it("keeps bundled runtime hooks synchronized with shared hook templates", () => {
    expect(readText(bundledWorkflowHookPath)).toBe(
      readText(sharedWorkflowHookPath),
    );
    expect(readText(bundledSubagentHookPath)).toBe(
      readText(sharedSubagentHookPath),
    );
  });

  it("runs the bundled hook even when a repository-local hook exists", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "trellis-codex-plugin-"),
    );
    try {
      const nested = path.join(tempRoot, "packages", "app");
      symlinkSync(
        path.join(repoRoot, ".trellis"),
        path.join(tempRoot, ".trellis"),
        process.platform === "win32" ? "junction" : "dir",
      );
      mkdirSync(nested, { recursive: true });
      mkdirSync(path.join(tempRoot, ".codex", "hooks"), { recursive: true });
      const markerPath = path.join(tempRoot, "local-hook-ran");
      writeFileSync(
        path.join(tempRoot, ".codex", "hooks", "inject-workflow-state.py"),
        `from pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text("ran")\nprint("local hook output")\n`,
      );

      const payload = {
        hook_event_name: "UserPromptSubmit",
        cwd: nested,
        prompt: "plugin bundled validation",
      };
      const output = execFileSync(process.execPath, [dispatcherPath], {
        cwd: repoRoot,
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
      });

      expect(output).toContain('"hookEventName": "UserPromptSubmit"');
      expect(output).toContain("<workflow-state>");
      expect(output).not.toContain("local hook output");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs the bundled hook when the repository-local hook is absent", () => {
    const output = execFileSync(process.execPath, [dispatcherPath], {
      cwd: repoRoot,
      input: `${JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: repoRoot,
        prompt: "plugin fallback validation",
      })}\n`,
      encoding: "utf8",
    });

    expect(output).toContain('"hookEventName": "UserPromptSubmit"');
    expect(output).toContain("<workflow-state>");
    expect(output).toContain("<codex-mode>");
  });

  it("is silent outside Trellis repositories and handles malformed cwd", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "trellis-codex-plugin-"),
    );
    try {
      const nonTrellis = path.join(tempRoot, "plain");
      mkdirSync(nonTrellis, { recursive: true });
      const noProjectOutput = execFileSync(process.execPath, [dispatcherPath], {
        cwd: pluginRoot,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: nonTrellis,
        }),
        encoding: "utf8",
      });
      expect(noProjectOutput).toBe("");

      const malformedCwdOutput = execFileSync(
        process.execPath,
        [dispatcherPath],
        {
          cwd: repoRoot,
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: { invalid: true },
          }),
          encoding: "utf8",
        },
      );
      expect(malformedCwdOutput).toContain("<workflow-state>");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}
