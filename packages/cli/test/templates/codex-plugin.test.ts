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
const pythonCommand = process.platform === "win32" ? "python" : "python3";

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

  it("does not execute repository-controlled Python helpers", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "trellis-codex-plugin-boundary-"),
    );
    try {
      const markerPath = path.join(tempRoot, "repository-helper-ran");
      mkdirSync(path.join(tempRoot, ".trellis", "scripts", "common"), {
        recursive: true,
      });
      writeFileSync(
        path.join(tempRoot, ".trellis", "config.yaml"),
        "codex:\n  dispatch_mode: inline\n",
      );
      writeFileSync(
        path.join(tempRoot, ".trellis", "workflow.md"),
        "# Workflow\n",
      );
      const malicious = `from pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text("ran")\n`;
      for (const helper of [
        "active_task.py",
        "config.py",
        "trellis_config.py",
      ]) {
        writeFileSync(
          path.join(tempRoot, ".trellis", "scripts", "common", helper),
          malicious,
        );
      }

      const output = execFileSync(process.execPath, [dispatcherPath], {
        cwd: repoRoot,
        input: `${JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: tempRoot,
          prompt: "plugin boundary validation",
        })}\n`,
        encoding: "utf8",
      });

      expect(output).toContain("<workflow-state>");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not borrow an unrelated sole session for a native subagent", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "trellis-codex-plugin-session-"),
    );
    try {
      mkdirSync(path.join(tempRoot, ".trellis", ".runtime", "sessions"), {
        recursive: true,
      });
      const taskDir = path.join(tempRoot, ".trellis", "tasks", "other-task");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify({ id: "other-task", status: "in_progress" }),
      );
      writeFileSync(
        path.join(
          tempRoot,
          ".trellis",
          ".runtime",
          "sessions",
          "codex-other.json",
        ),
        JSON.stringify({ current_task: ".trellis/tasks/other-task" }),
      );

      const script = [
        "from pathlib import Path",
        "import sys",
        "sys.path.insert(0, sys.argv[2])",
        "from plugin_support import resolve_active_task",
        "root = Path(sys.argv[1])",
        "active = resolve_active_task(root, {'session_id': 'missing'}, platform='codex', allow_single_session_fallback=False)",
        "assert active.task_path is None, active",
      ].join("\n");
      execFileSync(
        pythonCommand,
        ["-c", script, tempRoot, path.join(pluginRoot, "hooks", "runtime")],
        {
          encoding: "utf8",
        },
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ignores an inherited context override for native parent resolution", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "trellis-codex-plugin-context-"),
    );
    try {
      const sessionsDir = path.join(
        tempRoot,
        ".trellis",
        ".runtime",
        "sessions",
      );
      mkdirSync(sessionsDir, { recursive: true });
      const parentTask = path.join(
        tempRoot,
        ".trellis",
        "tasks",
        "parent-task",
      );
      const unrelatedTask = path.join(
        tempRoot,
        ".trellis",
        "tasks",
        "unrelated-task",
      );
      mkdirSync(parentTask, { recursive: true });
      mkdirSync(unrelatedTask, { recursive: true });
      writeFileSync(
        path.join(sessionsDir, "codex_parent.json"),
        JSON.stringify({ current_task: ".trellis/tasks/parent-task" }),
      );
      writeFileSync(
        path.join(sessionsDir, "codex_other.json"),
        JSON.stringify({ current_task: ".trellis/tasks/unrelated-task" }),
      );

      const script = [
        "from pathlib import Path",
        "import sys",
        "sys.path.insert(0, sys.argv[2])",
        "from plugin_support import resolve_active_task",
        "root = Path(sys.argv[1])",
        "active = resolve_active_task(root, {'session_id': 'parent'}, platform='codex', allow_single_session_fallback=False, allow_environment_context=False)",
        "assert active.task_path == '.trellis/tasks/parent-task', active",
      ].join("\n");
      execFileSync(
        pythonCommand,
        ["-c", script, tempRoot, path.join(pluginRoot, "hooks", "runtime")],
        {
          encoding: "utf8",
          env: { ...process.env, TRELLIS_CONTEXT_ID: "codex-other" },
        },
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
