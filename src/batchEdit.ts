import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { makeUnifiedDiff } from "./fsOps.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { hasSecretValue } from "./redact.js";

export interface BatchEditItem {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
  expected_replacements?: number;
}

interface StagedEditFile {
  path: string;
  absPath: string;
  before: string;
  after: string;
  replacements: number;
}

export interface BatchEditResult {
  paths: string[];
  files: Array<{ path: string; replacements: number; bytes: number }>;
  replacements: number;
  additions: number;
  deletions: number;
  changed: boolean;
  diff: string;
}

async function restoreFiles(files: StagedEditFile[]): Promise<void> {
  for (const file of files.reverse()) {
    try {
      await fsp.mkdir(path.dirname(file.absPath), { recursive: true });
      await fsp.writeFile(file.absPath, file.before, "utf8");
    } catch {
      // Preserve the original write failure; rollback is best-effort.
    }
  }
}

export async function batchEditTextFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  edits: BatchEditItem[]
): Promise<BatchEditResult> {
  if (!edits.length) throw new CodexProError("edits must contain at least one operation.");

  const stagedByPath = new Map<string, StagedEditFile>();
  for (const [index, edit] of edits.entries()) {
    if (!edit.path) throw new CodexProError(`edits.${index}.path is required.`);
    if (!edit.old_text) throw new CodexProError(`edits.${index}.old_text must not be empty.`);

    const resolved = guard.resolve(workspace, edit.path, { forWrite: true });
    let staged = stagedByPath.get(resolved.relPath);
    if (!staged) {
      await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
      const before = await fsp.readFile(resolved.absPath, "utf8");
      staged = { path: resolved.relPath, absPath: resolved.absPath, before, after: before, replacements: 0 };
      stagedByPath.set(resolved.relPath, staged);
    }

    const occurrences = staged.after.split(edit.old_text).length - 1;
    if (occurrences === 0) {
      throw new CodexProError(`edits.${index}.old_text was not found in ${staged.path}.`);
    }

    let replacementCount: number;
    if (edit.replace_all) {
      staged.after = staged.after.split(edit.old_text).join(edit.new_text);
      replacementCount = occurrences;
    } else {
      if (occurrences !== 1) {
        throw new CodexProError(
          `edits.${index}.old_text matched ${occurrences} times in ${staged.path}; provide more context or set replace_all=true.`
        );
      }
      staged.after = staged.after.replace(edit.old_text, edit.new_text);
      replacementCount = 1;
    }

    if (edit.expected_replacements !== undefined && replacementCount !== edit.expected_replacements) {
      throw new CodexProError(
        `edits.${index} expected ${edit.expected_replacements} replacements but would perform ${replacementCount}.`
      );
    }
    staged.replacements += replacementCount;
  }

  const staged = [...stagedByPath.values()].filter((file) => file.before !== file.after);
  for (const file of staged) {
    const bytes = Buffer.byteLength(file.after, "utf8");
    if (bytes > config.maxWriteBytes) {
      throw new CodexProError(`Edited file would be too large (${bytes} bytes): ${file.path}`);
    }
    if (hasSecretValue(file.after)) {
      throw new CodexProError(`Secret-looking content is blocked from batch edit output: ${file.path}`);
    }
  }

  const committed: StagedEditFile[] = [];
  try {
    for (const file of staged) {
      await fsp.writeFile(file.absPath, file.after, "utf8");
      committed.push(file);
    }
  } catch (error) {
    await restoreFiles(committed);
    throw error;
  }

  let additions = 0;
  let deletions = 0;
  const diffParts: string[] = [];
  for (const file of staged) {
    const result = makeUnifiedDiff(file.before, file.after, file.path);
    additions += result.additions;
    deletions += result.deletions;
    diffParts.push(`diff --git a/${file.path} b/${file.path}\n${result.diff}`);
  }

  return {
    paths: staged.map((file) => file.path),
    files: staged.map((file) => ({
      path: file.path,
      replacements: file.replacements,
      bytes: Buffer.byteLength(file.after, "utf8")
    })),
    replacements: staged.reduce((sum, file) => sum + file.replacements, 0),
    additions,
    deletions,
    changed: staged.length > 0,
    diff: diffParts.join("\n")
  };
}
