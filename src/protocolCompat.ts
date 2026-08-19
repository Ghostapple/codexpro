type UnknownRecord = Record<string, unknown>;

const EXPLICIT_ALIASES: Record<string, string[]> = {
  workspace_id: ["workspaceId"],
  path: ["filePath", "file_path", "filename"],
  start_line: ["startLine"],
  end_line: ["endLine"],
  max_bytes: ["maxBytes"],
  create_dirs: ["createDirs"],
  old_text: ["oldText", "search", "before"],
  new_text: ["newText", "replace", "after"],
  replace_all: ["replaceAll"],
  expected_replacements: ["expectedReplacements"],
  patch: ["diff", "content", "text"],
  patch_format: ["patchFormat", "format"],
  edits: ["changes", "operations"],
  atomic: ["transactional"]
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function unwrapCommonEnvelope(raw: unknown, schemaKeys: Set<string>): UnknownRecord {
  if (!isRecord(raw)) return {};
  if ([...schemaKeys].some((key) => key in raw)) return { ...raw };

  for (const key of ["arguments", "args", "input", "payload"]) {
    const nested = raw[key];
    if (isRecord(nested)) return { ...nested };
  }
  return { ...raw };
}

function copyAlias(out: UnknownRecord, canonical: string, aliases: string[]): void {
  if (out[canonical] !== undefined) return;
  for (const alias of aliases) {
    if (out[alias] !== undefined) {
      out[canonical] = out[alias];
      return;
    }
  }
}

function normalizeEditItem(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out = { ...value };
  copyAlias(out, "path", EXPLICIT_ALIASES.path);
  copyAlias(out, "old_text", EXPLICIT_ALIASES.old_text);
  copyAlias(out, "new_text", EXPLICIT_ALIASES.new_text);
  copyAlias(out, "replace_all", EXPLICIT_ALIASES.replace_all);
  copyAlias(out, "expected_replacements", EXPLICIT_ALIASES.expected_replacements);
  return out;
}

/**
 * Accepts common MCP/client argument envelopes and naming conventions while
 * preserving the canonical snake_case contract advertised by CodexProV4.
 */
export function normalizeToolArguments(raw: unknown, schemaKeys: Iterable<string>): UnknownRecord {
  const keys = new Set(schemaKeys);
  const out = unwrapCommonEnvelope(raw, keys);

  for (const canonical of keys) {
    const aliases = new Set<string>([
      camelCase(canonical),
      ...(EXPLICIT_ALIASES[canonical] ?? [])
    ]);
    aliases.delete(canonical);
    copyAlias(out, canonical, [...aliases]);
  }

  if (Array.isArray(out.edits)) {
    out.edits = out.edits.map(normalizeEditItem);
  }

  return out;
}
