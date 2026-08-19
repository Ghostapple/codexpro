import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { makeUnifiedDiff } from "./fsOps.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";

export type PatchFormat = "auto" | "git" | "codex";

interface CodexHunk {
  lines: string[];
  endOfFile: boolean;
}

interface CodexPatchOperation {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  content?: string;
  hunks?: CodexHunk[];
}

interface StagedFile {
  relPath: string;
  absPath: string;
  before: string | null;
  after: string | null;
}

export interface CompatiblePatchResult {
  paths: string[];
  stdout: string;
  stderr: string;
  diff: string;
  additions: number;
  deletions: number;
  changed: boolean;
  format: "git" | "codex";
}

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function isOperationHeader(line: string): boolean {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Update File: ") ||
    line.startsWith("*** Delete File: ") ||
    line === "*** End Patch"
  );
}

function parsePathHeader(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (!value) throw new CodexProError(`Missing path in patch header: ${line}`);
  return value;
}

export function detectPatchFormat(patch: string, requested: PatchFormat = "auto"): "git" | "codex" {
  if (requested === "git" || requested === "codex") return requested;
  const trimmed = patch.trimStart();
  if (trimmed.startsWith("*** Begin Patch")) return "codex";
  return "git";
}

function parseCodexPatch(patch: string): CodexPatchOperation[] {
  const lines = normalizeLines(patch);
  let index = 0;
  while (index < lines.length && lines[index] === "") index += 1;
  if (lines[index] !== "*** Begin Patch") {
    throw new CodexProError("Codex patch must start with '*** Begin Patch'.");
  }
  index += 1;

  const operations: CodexPatchOperation[] = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      index += 1;
      break;
    }
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = parsePathHeader(line, "*** Add File: ");
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length && !isOperationHeader(lines[index])) {
        const bodyLine = lines[index];
        if (!bodyLine.startsWith("+")) {
          throw new CodexProError(`Add File lines must start with '+': ${bodyLine}`);
        }
        contentLines.push(bodyLine.slice(1));
        index += 1;
      }
      const content = contentLines.length ? `${contentLines.join("\n")}\n` : "";
      operations.push({ kind: "add", path: filePath, content });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = parsePathHeader(line, "*** Delete File: ");
      index += 1;
      if (index < lines.length && !isOperationHeader(lines[index]) && lines[index] !== "") {
        throw new CodexProError("Delete File sections cannot contain patch body lines.");
      }
      operations.push({ kind: "delete", path: filePath });
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = parsePathHeader(line, "*** Update File: ");
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = parsePathHeader(lines[index], "*** Move to: ");
        index += 1;
      }

      const hunks: CodexHunk[] = [];
      while (index < lines.length && !isOperationHeader(lines[index])) {
        if (lines[index] === "") {
          index += 1;
          continue;
        }
        if (!lines[index].startsWith("@@")) {
          throw new CodexProError(`Expected '@@' hunk header in ${filePath}, got: ${lines[index]}`);
        }
        index += 1;
        const hunkLines: string[] = [];
        let endOfFile = false;
        while (index < lines.length && !isOperationHeader(lines[index]) && !lines[index].startsWith("@@")) {
          const bodyLine = lines[index];
          if (bodyLine === "*** End of File") {
            endOfFile = true;
            index += 1;
            continue;
          }
          if (bodyLine !== "" && ![" ", "+", "-"].includes(bodyLine[0])) {
            throw new CodexProError(`Invalid hunk line in ${filePath}: ${bodyLine}`);
          }
          hunkLines.push(bodyLine === "" ? " " : bodyLine);
          index += 1;
        }
        if (!hunkLines.length) throw new CodexProError(`Empty hunk in ${filePath}.`);
        hunks.push({ lines: hunkLines, endOfFile });
      }
      if (!hunks.length) throw new CodexProError(`Update File section has no hunks: ${filePath}`);
      operations.push({ kind: "update", path: filePath, moveTo, hunks });
      continue;
    }

    throw new CodexProError(`Unknown Codex patch directive: ${line}`);
  }

  if (!operations.length) throw new CodexProError("Codex patch contains no file operations.");
  if (!lines.slice(index).every((line) => line === "")) {
    throw new CodexProError("Unexpected content after '*** End Patch'.");
  }
  return operations;
}

function findSubsequence(haystack: string[], needle: string[], start: number, preferLast: boolean): number {
  if (!needle.length) return preferLast ? haystack.length : Math.min(start, haystack.length);
  const matches: number[] = [];
  for (let index = Math.max(0, start); index <= haystack.length - needle.length; index += 1) {
    let matchesHere = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matchesHere = false;
        break;
      }
    }
    if (matchesHere) matches.push(index);
  }
  if (!matches.length && start > 0) return findSubsequence(haystack, needle, 0, preferLast);
  if (!matches.length) return -1;
  return preferLast ? matches[matches.length - 1] : matches[0];
}

function applyHunks(filePath: string, before: string, hunks: CodexHunk[]): string {
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  let lines = normalizeLines(before);
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix !== "+") oldLines.push(text);
      if (prefix !== "-") newLines.push(text);
    }

    const found = findSubsequence(lines, oldLines, cursor, hunk.endOfFile);
    if (found < 0) {
      const preview = oldLines.slice(0, 4).join("\\n");
      throw new CodexProError(`Patch context was not found in ${filePath}: ${preview}`);
    }
    lines.splice(found, oldLines.length, ...newLines);
    cursor = found + newLines.length;
  }

  return lines.join(eol);
}

async function readExisting(absPath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) throw new CodexProError(`Not a regular file: ${absPath}`);
    return await fsp.readFile(absPath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function commitStagedFiles(staged: StagedFile[]): Promise<void> {
  const committed: StagedFile[] = [];
  try {
    for (const file of staged) {
      if (file.after === null) {
        await fsp.unlink(file.absPath);
      } else {
        await fsp.mkdir(path.dirname(file.absPath), { recursive: true });
        await fsp.writeFile(file.absPath, file.after, "utf8");
      }
      committed.push(file);
    }
  } catch (error) {
    for (const file of committed.reverse()) {
      try {
        if (file.before === null) await fsp.rm(file.absPath, { force: true });
        else {
          await fsp.mkdir(path.dirname(file.absPath), { recursive: true });
          await fsp.writeFile(file.absPath, file.before, "utf8");
        }
      } catch {
        // Preserve the original commit error; rollback is best-effort.
      }
    }
    throw error;
  }
}

export async function applyCodexPatch(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): Promise<CompatiblePatchResult> {
  const operations = parseCodexPatch(patch);
  const stagedByPath = new Map<string, StagedFile>();

  async function currentFile(filePath: string): Promise<StagedFile> {
    const resolved = guard.resolve(workspace, filePath, { forWrite: true });
    const existing = stagedByPath.get(resolved.relPath);
    if (existing) return existing;
    const before = await readExisting(resolved.absPath);
    const staged: StagedFile = { relPath: resolved.relPath, absPath: resolved.absPath, before, after: before };
    stagedByPath.set(resolved.relPath, staged);
    return staged;
  }

  for (const operation of operations) {
    const source = await currentFile(operation.path);
    if (operation.kind === "add") {
      if (source.after !== null) throw new CodexProError(`Add File target already exists: ${source.relPath}`);
      source.after = operation.content ?? "";
      continue;
    }
    if (operation.kind === "delete") {
      if (source.after === null) throw new CodexProError(`Delete File target does not exist: ${source.relPath}`);
      source.after = null;
      continue;
    }

    if (source.after === null) throw new CodexProError(`Update File target does not exist: ${source.relPath}`);
    const updated = applyHunks(source.relPath, source.after, operation.hunks ?? []);
    if (operation.moveTo) {
      const target = await currentFile(operation.moveTo);
      if (target.after !== null) throw new CodexProError(`Move target already exists: ${target.relPath}`);
      source.after = null;
      target.after = updated;
    } else {
      source.after = updated;
    }
  }

  const staged = [...stagedByPath.values()].filter((file) => file.before !== file.after);
  for (const file of staged) {
    if (file.after !== null) {
      const bytes = Buffer.byteLength(file.after, "utf8");
      if (bytes > config.maxWriteBytes) {
        throw new CodexProError(`Patched file would be too large (${bytes} bytes): ${file.relPath}`);
      }
    }
  }

  await commitStagedFiles(staged);

  let additions = 0;
  let deletions = 0;
  const diffParts: string[] = [];
  for (const file of staged) {
    const result = makeUnifiedDiff(file.before ?? "", file.after ?? "", file.relPath);
    additions += result.additions;
    deletions += result.deletions;
    diffParts.push(`diff --git a/${file.relPath} b/${file.relPath}\n${result.diff}`);
  }

  return {
    paths: staged.map((file) => file.relPath),
    stdout: "",
    stderr: "",
    diff: diffParts.join("\n"),
    additions,
    deletions,
    changed: staged.length > 0,
    format: "codex"
  };
}
