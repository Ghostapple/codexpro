import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeToolArguments } from "../dist/protocolCompat.js";
import { applyCodexPatch, detectPatchFormat } from "../dist/codexPatch.js";
import { batchEditTextFiles } from "../dist/batchEdit.js";
import { PathGuard } from "../dist/guard.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexprov2-smoke-"));
const config = {
  defaultRoot: root,
  allowedRoots: [root],
  host: "127.0.0.1",
  port: 8788,
  widgetDomain: "https://example.com",
  requireHttpToken: false,
  bashMode: "off",
  commandShell: "auto",
  bashTranscript: "compact",
  requireBashSession: false,
  codexSessions: "off",
  codexDir: path.join(root, ".codex"),
  writeMode: "workspace",
  toolMode: "standard",
  inheritEnv: false,
  maxReadBytes: 180_000,
  maxTransferBytes: 50 * 1024 * 1024,
  maxActiveTransfers: 1,
  transferExtraMimeTypes: [],
  maxWriteBytes: 1_000_000,
  maxOutputBytes: 120_000,
  maxSearchResults: 200,
  maxHttpSessions: 64,
  httpSessionTtlMs: 1_800_000,
  blockedGlobs: [".git", ".git/**", "**/.git/**"],
  contextDir: ".ai-bridge",
  toolCards: false
};
const workspace = { id: "ws_smoke", root, openedAt: new Date().toISOString() };
const guard = new PathGuard(config);

try {
  assert.equal(detectPatchFormat("*** Begin Patch\n*** End Patch\n"), "codex");
  assert.equal(detectPatchFormat("diff --git a/a b/a\n"), "git");

  const normalized = normalizeToolArguments(
    {
      arguments: {
        workspaceId: "ws_1",
        patchFormat: "codex",
        content: "*** Begin Patch\n*** End Patch\n"
      }
    },
    ["workspace_id", "patch", "patch_format"]
  );
  assert.equal(normalized.workspace_id, "ws_1");
  assert.equal(normalized.patch_format, "codex");
  assert.equal(normalized.patch, "*** Begin Patch\n*** End Patch\n");

  await fs.writeFile(path.join(root, "a.txt"), "alpha\nomega\n", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "left\nright\n", "utf8");

  const patchResult = await applyCodexPatch(
    config,
    guard,
    workspace,
    [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " alpha",
      "-omega",
      "+omega patched",
      " ",
      "*** Add File: added.txt",
      "+created by codex patch",
      "*** End Patch",
      ""
    ].join("\n")
  );
  assert.equal(patchResult.format, "codex");
  assert.deepEqual(new Set(patchResult.paths), new Set(["a.txt", "added.txt"]));
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "alpha\nomega patched\n");
  assert.equal(await fs.readFile(path.join(root, "added.txt"), "utf8"), "created by codex patch\n");

  const batchResult = await batchEditTextFiles(config, guard, workspace, [
    { path: "a.txt", old_text: "omega patched", new_text: "omega final" },
    { path: "b.txt", old_text: "left", new_text: "up" },
    { path: "b.txt", old_text: "right", new_text: "down" }
  ]);
  assert.equal(batchResult.replacements, 3);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "alpha\nomega final\n");
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "up\ndown\n");

  const serverSource = await fs.readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const codexPatchSource = await fs.readFile(new URL("../src/codexPatch.ts", import.meta.url), "utf8");
  assert(!serverSource.includes("Secret-looking content is blocked from apply_patch"));
  assert(!codexPatchSource.includes("hasSecretValue"));

  console.log("CodexProV2 protocol smoke test passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
