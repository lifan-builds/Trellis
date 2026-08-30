import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const pluginRoot = path.join(repoRoot, "plugins", "codex");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const hooksPath = path.join(pluginRoot, "hooks", "codex-hooks.json");
const dispatcherPath = path.join(
  pluginRoot,
  "hooks",
  "trellis-codex-dispatch.cjs",
);

describe("Trellis Codex plugin", () => {
  it("declares the manifest and both supported hook events", () => {
    const manifest = JSON.parse(
      readText(manifestPath),
    ) as { hooks?: string; name?: string };
    const hooks = JSON.parse(readText(hooksPath)) as {
      hooks?: Record<string, unknown>;
    };

    expect(manifest.name).toBe("trellis");
    expect(manifest.hooks).toBe("./hooks/codex-hooks.json");
    expect(Object.keys(hooks.hooks ?? {}).sort()).toEqual([
      "SubagentStart",
      "UserPromptSubmit",
    ]);
  });

  it("forwards the original event to a repository-local hook", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "trellis-codex-plugin-"));
    try {
      const nested = path.join(tempRoot, "packages", "app");
      mkdirSync(path.join(tempRoot, ".trellis"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      mkdirSync(path.join(tempRoot, ".codex", "hooks"), { recursive: true });
      writeFileSync(
        path.join(tempRoot, ".codex", "hooks", "inject-workflow-state.py"),
        "import sys\nprint(sys.stdin.read(), end='')\n",
      );

      const payload = { hook_event_name: "UserPromptSubmit", cwd: nested, prompt: "hello" };
      const output = execFileSync(process.execPath, [dispatcherPath], {
        cwd: pluginRoot,
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
      });

      expect(output).toBe(`${JSON.stringify(payload)}\n`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("is silent outside Trellis repositories and without a local hook", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "trellis-codex-plugin-"));
    try {
      const nonTrellis = path.join(tempRoot, "plain");
      mkdirSync(nonTrellis, { recursive: true });
      const noProjectOutput = execFileSync(process.execPath, [dispatcherPath], {
        cwd: pluginRoot,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: nonTrellis }),
        encoding: "utf8",
      });
      expect(noProjectOutput).toBe("");

      const trellisRoot = path.join(tempRoot, "trellis");
      mkdirSync(path.join(trellisRoot, ".trellis"), { recursive: true });
      const noHookOutput = execFileSync(process.execPath, [dispatcherPath], {
        cwd: pluginRoot,
        input: JSON.stringify({ hook_event_name: "SubagentStart", cwd: trellisRoot }),
        encoding: "utf8",
      });
      expect(noHookOutput).toBe("");
      expect(existsSync(path.join(trellisRoot, ".codex"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}
