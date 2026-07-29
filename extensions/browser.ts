/**
 * Playwright Browser Extension for Pi
 *
 * Wraps playwright-cli to give the agent web-browsing capabilities through a
 * real Chromium instance.  Uses the page accessibility snapshot (plain text)
 * as the primary representation, so both vision and non-vision models can
 * browse the web effectively.
 *
 * Tools (6 total):
 *   browser_navigate   – Navigate to a URL; returns snapshot
 *   browser_snapshot   – Capture / search the accessibility tree
 *   browser_act        – Interact with the page (click, type, fill, hover,
 *                         select, press, scroll, back, forward)
 *   browser_screenshot – Take a visual screenshot (inline image for vision
 *                         models, file path for text-only models)
 *   browser_eval       – Run JavaScript on the page
 *   browser_close      – Close the browser
 *
 * Lifecycle:
 *   - Browser opens lazily on the first navigate / snapshot / eval call.
 *   - On normal pi shutdown the browser is closed automatically.
 *   - If pi crashes, orphaned sessions can be cleaned up with:
 *         playwright-cli close-all
 *         playwright-cli kill-all   (for stuck/zombie processes)
 *
 * Prerequisites:
 *   npm i -g @playwright/cli
 *   playwright-cli install
 */

import { exec } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

const SESSION = "pi-browser";
const PW = "playwright-cli";
const HOME = process.env.HOME || process.env.USERPROFILE || ".";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a shell argument (cross-platform). */
function quote(s: string): string {
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Run playwright-cli with the shared session. Returns trimmed stdout. */
async function pw(args: string, timeoutMs = 30000): Promise<string> {
  const cmd = `${PW} -s=${SESSION} ${args}`;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = stdout.trim();
    if (out) return out;
    const err = stderr.trim();
    if (err && /error/i.test(err)) throw new Error(err);
    return err;
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(msg);
  }
}

async function pwRaw(args: string, timeoutMs = 30000): Promise<string> {
  return pw(`${args} --raw`, timeoutMs);
}

function isNotOpenError(err: Error): boolean {
  return /not open/i.test(err.message);
}

let browserOpen = false;

/** Make sure a browser session exists, opening one if needed. */
async function ensureBrowser(): Promise<void> {
  if (browserOpen) return;
  try {
    await pw("snapshot", 8000);
    browserOpen = true;
  } catch (err: any) {
    if (isNotOpenError(err) || /error/i.test(err.message)) {
      await pw("open about:blank", 15000);
      browserOpen = true;
    }
  }
}

/** Read a .playwright-cli snapshot YAML file (path relative to HOME). */
async function readSnapshotFile(fileRel: string): Promise<string> {
  const filePath = resolve(HOME, fileRel);
  try {
    await access(filePath, constants.R_OK);
    return await readFile(filePath, "utf-8");
  } catch {
    return `(snapshot file not readable: ${fileRel})`;
  }
}

/**
 * Run a playwright-cli command that returns a `snapshot` in its JSON output
 * (either inline as a string or as a `file` path to a .yml file).
 */
async function getSnapshot(jsonOutput: string): Promise<string> {
  try {
    const parsed = JSON.parse(jsonOutput);
    if (parsed.isError) return `Error: ${parsed.error || jsonOutput}`;
    const snap = parsed.snapshot;
    if (!snap) return "(no snapshot)";
    if (typeof snap === "string") return snap;
    if (typeof snap.file === "string") return await readSnapshotFile(snap.file);
    return JSON.stringify(snap, null, 2);
  } catch {
    // Not JSON – maybe the raw result contains a file path.
    const m = jsonOutput.match(/\.playwright-cli[\\/][^\s)]+\.yml/i);
    if (m) return await readSnapshotFile(m[0]);
    return jsonOutput;
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -- browser_navigate --------------------------------------------------
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Navigate the browser to a URL. Automatically opens the browser on first use. " +
      "Returns the page accessibility snapshot – a structured text representation " +
      "of all interactive elements with [ref=eN] identifiers.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL including protocol, e.g. https://example.com" }),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureBrowser();
        const raw = await pw(`goto ${quote(params.url)} --json`, 45000);
        const snapshot = await getSnapshot(raw);
        if (snapshot.startsWith("Error:")) {
          return {
            content: [{ type: "text", text: `Navigation failed: ${snapshot}` }],
            details: { error: snapshot },
          };
        }
        return {
          content: [{ type: "text", text: `Navigated to ${params.url}\n\n${snapshot}` }],
          details: { url: params.url },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_navigate error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // -- browser_snapshot --------------------------------------------------
  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Capture the accessibility snapshot of the current page as structured text. " +
      "Optionally filter to a specific element (by CSS selector or ref) or search " +
      "for text/regex. Every interactive element has a [ref=eN] identifier you can " +
      "pass to browser_act for clicks, fills, hovers, and selects.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description:
            "CSS selector or element ref (e.g. e3) to snapshot only that subtree. Omit for full page.",
        })
      ),
      find: Type.Optional(
        Type.String({
          description:
            "Text or regex to search within the page snapshot. Returns matching nodes with surrounding context.",
        })
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureBrowser();
        if (params.find) {
          const raw = await pw(`find ${quote(params.find)} --json`, 15000);
          const parsed = JSON.parse(raw);
          if (parsed.isError) {
            return {
              content: [{ type: "text", text: `Find failed: ${parsed.error || raw}` }],
              details: { error: parsed.error },
            };
          }
          const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
          return {
            content: [{ type: "text", text: text || "(no matches)" }],
            details: { query: params.find },
          };
        }

        const target = params.selector ? ` ${quote(params.selector)}` : "";
        const raw = await pw(`snapshot${target} --json`, 15000);
        const snapshot = await getSnapshot(raw);
        if (snapshot.startsWith("Error:")) {
          return {
            content: [{ type: "text", text: `Snapshot failed: ${snapshot}` }],
            details: { error: snapshot },
          };
        }
        return { content: [{ type: "text", text: snapshot }], details: {} };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_snapshot error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // -- browser_act -------------------------------------------------------
  //
  // Consolidated interaction tool.  The `action` parameter selects the
  // operation; the other parameters are used depending on the action.
  //
  pi.registerTool({
    name: "browser_act",
    label: "Browser Act",
    description:
      "Perform an interaction on the current page. Returns a fresh page snapshot " +
      "after the action completes (except for scroll / press which are instantaneous " +
      "and return a brief confirmation).\n" +
      "\n" +
      "Actions and the parameters they use:\n" +
      "  click       – click element by `ref`\n" +
      "  dblclick    – double-click element by `ref`\n" +
      "  type        – type `text` into the currently focused / first editable element\n" +
      "  fill        – clear & fill `text` into form field identified by `ref`\n" +
      "  hover       – hover over element by `ref`\n" +
      "  select      – select `value` in <select> identified by `ref`\n" +
      "  press       – press `key` (Enter, Tab, Escape, ArrowDown, a, 1, …)\n" +
      "  scroll      – scroll by (`dx`, `dy`) pixels; positive dy = down\n" +
      "  back        – go back in history\n" +
      "  forward     – go forward in history",
    parameters: Type.Object({
      action: Type.String({
        description:
          "Interaction type: click, dblclick, type, fill, hover, select, press, scroll, back, forward",
      }),
      ref: Type.Optional(Type.String({ description: "Element ref from snapshot (e.g. e5). Used by: click, dblclick, fill, hover, select" })),
      text: Type.Optional(Type.String({ description: "Text to type or fill. Used by: type, fill" })),
      key: Type.Optional(Type.String({ description: "Key to press. Used by: press. Examples: Enter, Tab, Escape, ArrowDown, PageDown, a" })),
      value: Type.Optional(Type.String({ description: "Option value/label. Used by: select" })),
      dx: Type.Optional(Type.Number({ description: "Horizontal scroll px (default 0). Used by: scroll" })),
      dy: Type.Optional(Type.Number({ description: "Vertical scroll px, positive = down. Used by: scroll" })),
    }),
    async execute(_toolCallId, params) {
      const action = params.action.toLowerCase();
      try {
        await ensureBrowser();

        let cmd: string;
        let wantsSnapshot: boolean;

        switch (action) {
          case "click":
            if (!params.ref) throw new Error("'ref' is required for click");
            cmd = `click ${quote(params.ref)}`;
            wantsSnapshot = true;
            break;
          case "dblclick":
            if (!params.ref) throw new Error("'ref' is required for dblclick");
            cmd = `dblclick ${quote(params.ref)}`;
            wantsSnapshot = true;
            break;
          case "type":
            if (!params.text) throw new Error("'text' is required for type");
            cmd = `type ${quote(params.text)}`;
            wantsSnapshot = false;
            break;
          case "fill":
            if (!params.ref) throw new Error("'ref' is required for fill");
            if (params.text === undefined) throw new Error("'text' is required for fill");
            cmd = `fill ${quote(params.ref)} ${quote(params.text)}`;
            wantsSnapshot = true;
            break;
          case "hover":
            if (!params.ref) throw new Error("'ref' is required for hover");
            cmd = `hover ${quote(params.ref)}`;
            wantsSnapshot = false;
            break;
          case "select":
            if (!params.ref) throw new Error("'ref' is required for select");
            if (!params.value) throw new Error("'value' is required for select");
            cmd = `select ${quote(params.ref)} ${quote(params.value)}`;
            wantsSnapshot = false;
            break;
          case "press":
            if (!params.key) throw new Error("'key' is required for press");
            cmd = `press ${quote(params.key)}`;
            wantsSnapshot = false;
            break;
          case "scroll":
            {
              const dx = params.dx ?? 0;
              const dy = params.dy ?? 0;
              cmd = `mousewheel ${dx} ${dy}`;
              wantsSnapshot = false;
            }
            break;
          case "back":
            cmd = "go-back";
            wantsSnapshot = true;
            break;
          case "forward":
            cmd = "go-forward";
            wantsSnapshot = true;
            break;
          default:
            throw new Error(
              `Unknown action "${action}". Supported: click, dblclick, type, fill, hover, select, press, scroll, back, forward`
            );
        }

        const raw = await pw(`${cmd} --json`, 30000);
        const parsed = JSON.parse(raw);
        if (parsed.isError) {
          return {
            content: [{ type: "text", text: `${action} failed: ${parsed.error || raw}` }],
            details: { error: parsed.error, action },
          };
        }

        if (wantsSnapshot) {
          const snapshot = await getSnapshot(raw);
          return {
            content: [{ type: "text", text: `${action} succeeded\n\n${snapshot}` }],
            details: { action },
          };
        }

        return {
          content: [{ type: "text", text: `${action} succeeded` }],
          details: { action },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_act error (${action}): ${err.message}` }],
          details: { error: err.message, action },
        };
      }
    },
  });

  // -- browser_screenshot ------------------------------------------------
  //
  // Returns an inline base64 image for vision models AND a file path for
  // text-only models.  Text-only models will see the file path in the text
  // content and can still reason about "a screenshot was taken at path X".
  //
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Take a screenshot of the current viewport. Vision-enabled models receive the " +
      "image inline; text-only models receive the file path. Either way the page is " +
      "captured for later inspection.",
    parameters: Type.Object({}),
    async execute() {
      try {
        await ensureBrowser();
        const raw = await pwRaw("screenshot", 15000);
        // playwright-cli --raw output: "- [Screenshot of viewport](.playwright-cli\\page-...-.png)"
        const linkMatch = raw.match(/\(([^)]+\.png)\)/i);
        if (!linkMatch) {
          return {
            content: [{ type: "text", text: `Screenshot taken (raw output):\n${raw}` }],
            details: {},
          };
        }

        const fullPath = resolve(HOME, linkMatch[1]);
        let base64: string | undefined;
        try {
          const buf = await readFile(fullPath);
          base64 = buf.toString("base64");
        } catch {
          // File exists but we can't read it back – still useful information.
        }

        const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; mediaType: "image/png"; data: string } }> = [
          { type: "text", text: `Screenshot saved to: ${fullPath}` },
        ];

        if (base64) {
          content.push({
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: base64 },
          });
        }

        return { content, details: { path: fullPath } };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_screenshot error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // -- browser_eval ------------------------------------------------------
  pi.registerTool({
    name: "browser_eval",
    label: "Browser Eval",
    description:
      "Evaluate a JavaScript expression on the page (or on a specific element) and " +
      "return the result. Use this to extract data, read computed styles, or interact " +
      "with the DOM programmatically when the accessibility snapshot is insufficient.",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression, e.g. document.title or document.querySelectorAll('a').length" }),
      ref: Type.Optional(Type.String({ description: "Optional element ref to run the expression on instead of the whole page" })),
    }),
    async execute(_toolCallId, params) {
      try {
        await ensureBrowser();
        const target = params.ref ? ` ${quote(params.ref)}` : "";
        const raw = await pw(`eval ${quote(params.expression)}${target} --json`, 15000);
        const parsed = JSON.parse(raw);
        if (parsed.isError) {
          return {
            content: [{ type: "text", text: `Eval failed: ${parsed.error || raw}` }],
            details: { error: parsed.error },
          };
        }
        const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { expression: params.expression },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_eval error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // -- browser_close -----------------------------------------------------
  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description:
      "Close the browser session and free system resources. Call this when browsing " +
      "is done. (The browser is also closed automatically on normal pi shutdown.)",
    parameters: Type.Object({}),
    async execute() {
      try {
        const raw = await pw("close --json", 10000);
        browserOpen = false;
        return {
          content: [{ type: "text", text: `Browser closed: ${raw}` }],
          details: {},
        };
      } catch (err: any) {
        browserOpen = false;
        if (isNotOpenError(err)) {
          return {
            content: [{ type: "text", text: "Browser was not open." }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: `browser_close error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  // -- Lifecycle cleanup -------------------------------------------------
  //
  // Normal shutdown: close the browser so no orphaned Chromium processes
  // linger.  If pi is killed (SIGKILL / taskkill / crash), the browser
  // process stays alive.  The user can recover with:
  //     playwright-cli close-all
  //     playwright-cli kill-all
  //
  pi.on("session_shutdown", async () => {
    try {
      await pw("close", 5000);
      browserOpen = false;
    } catch {
      // best-effort
    }
  });
}
