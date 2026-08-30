#!/usr/bin/env node

/** Forward a Codex plugin event to the matching repository-local Trellis hook. */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGETS = new Map([
  ["UserPromptSubmit", ".codex/hooks/inject-workflow-state.py"],
  ["SubagentStart", ".codex/hooks/inject-subagent-context.py"],
]);

function findTrellisRoot(start) {
  let current;
  try {
    current = path.resolve(start);
  } catch {
    return null;
  }
  while (true) {
    try {
      if (fs.statSync(path.join(current, ".trellis")).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking when a candidate .trellis entry is unreadable or absent.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readInput() {
  try {
    const raw = fs.readFileSync(0);
    const data = JSON.parse(raw.toString("utf8"));
    return { data: data && typeof data === "object" ? data : {}, raw };
  } catch {
    return { data: {}, raw: Buffer.alloc(0) };
  }
}

function pythonCommands() {
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

function main() {
  const { data, raw } = readInput();
  const relativeTarget = TARGETS.get(data.hook_event_name);
  if (!relativeTarget) return 0;

  const start = typeof data.cwd === "string" ? data.cwd : process.cwd();
  const root = findTrellisRoot(start);
  if (!root) return 0;
  const target = path.join(root, relativeTarget);
  try {
    if (!fs.statSync(target).isFile()) return 0;
  } catch {
    return 0;
  }

  for (const command of pythonCommands()) {
    const result = spawnSync(command, [target], {
      cwd: root,
      input: raw,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.error) continue;
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
    return result.status ?? 0;
  }
  return 0;
}

process.exitCode = main();
