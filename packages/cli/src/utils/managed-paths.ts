import fs from "node:fs";
import path from "node:path";

import { isManagedPath, isManagedRootDir } from "../configurators/index.js";

export const TRELLIS_BLOCK_START = "<!-- TRELLIS:START -->";
export const TRELLIS_BLOCK_END = "<!-- TRELLIS:END -->";

/** Remove empty managed parents without deleting a managed root directory. */
export function cleanupEmptyDirs(cwd: string, dirPath: string): void {
  const fullPath = path.join(cwd, dirPath);

  if (!isManagedPath(dirPath) || isManagedRootDir(dirPath)) return;
  if (!fs.existsSync(fullPath)) return;

  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) return;

    if (fs.readdirSync(fullPath).length === 0) {
      fs.rmdirSync(fullPath);
      const parent = path.dirname(dirPath);
      if (parent !== "." && parent !== dirPath && !isManagedRootDir(parent)) {
        cleanupEmptyDirs(cwd, parent);
      }
    }
  } catch {
    // Cleanup is best-effort; permission/race failures leave the directory.
  }
}
