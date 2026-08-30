#!/usr/bin/env node

/** Forward a Codex plugin event to the repository-local or bundled Trellis hook. */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGETS = new Map([
  [
    "UserPromptSubmit",
    {
      local: ".codex/hooks/inject-workflow-state.py",
      bundled: "inject-workflow-state.py",
    },
  ],
  [
    "SubagentStart",
    {
      local: ".codex/hooks/inject-subagent-context.py",
      bundled: "inject-subagent-context.py",
    },
  ],
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
  return process.platform === "win32"
    ? ["python", "py"]
    : ["python3", "python"];
}

function main() {
  const { data, raw } = readInput();
  const targetConfig = TARGETS.get(data.hook_event_name);
  if (!targetConfig) return 0;

  const start = typeof data.cwd === "string" ? data.cwd : process.cwd();
  const root = findTrellisRoot(start);
  if (!root) return 0;
  let target = path.join(root, targetConfig.local);
  if (!isFile(target)) {
    target = path.join(__dirname, "runtime", targetConfig.bundled);
    if (!isFile(target)) return 0;
  }

  for (const command of pythonCommands()) {
    const result = spawnSync(command, [target], {
      cwd: root,
      input: raw,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CODEX_PROJECT_DIR: root },
    });
    if (result.error) continue;
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
    return result.status ?? 0;
  }
  return 0;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

process.exitCode = main();
