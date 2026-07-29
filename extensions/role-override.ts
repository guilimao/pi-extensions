/**
 * role-override - Replace the default role definition with ROLE.md
 *
 * Resolution order:
 *   1. <project>/ROLE.md          (project-specific role)
 *   2. ~/.pi/agent/ROLE.md        (global default role)
 *   3. Pi's built-in default role (if neither file exists)
 *
 * All other system-prompt contents (tools, guidelines, docs, context files,
 * skills, date, cwd) are preserved untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_ROLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

function readRole(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const globalRolePath = join(homedir(), ".pi", "agent", "ROLE.md");

  pi.on("before_agent_start", async (event, ctx) => {
    // 1. Project-level ROLE.md
    // 2. Global ~/.pi/agent/ROLE.md
    // 3. Pi built-in default
    const projectRolePath = join(ctx.cwd, "ROLE.md");
    const roleContent =
      readRole(projectRolePath) ??
      readRole(globalRolePath);

    if (!roleContent) return; // Neither exists, use pi default

    const prompt = event.systemPrompt.replace(DEFAULT_ROLE, roleContent);
    return { systemPrompt: prompt };
  });
}
