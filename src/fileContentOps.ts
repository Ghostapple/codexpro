import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileTypeFromFile } from "file-type";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { CodexProConfig } from "./config.js";
import { readTextFile, type ReadFileResult } from "./fsOps.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const BUILT_IN_TRANSFER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/mpeg",
  "video/mp2t"
]);

const EXPECTED_MIME_BY_EXTENSION: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
  ".bmp": ["image/bmp"],
  ".tif": ["image/tiff"],
  ".tiff": ["image/tiff"],
  ".mp3": ["audio/mpeg"],
  ".wav": ["audio/wav", "audio/x-wav"],
  ".m4a": ["audio/mp4"],
  ".aac": ["audio/aac"],
  ".ogg": ["audio/ogg", "video/ogg"],
  ".flac": ["audio/flac", "audio/x-flac"],
  ".mp4": ["video/mp4", "audio/mp4"],
  ".webm": ["video/webm", "audio/webm"],
  ".mov": ["video/quicktime"],
  ".m4v": ["video/x-m4v", "video/mp4"],
  ".mpeg": ["video/mpeg"],
  ".mpg": ["video/mpeg"],
  ".ts": ["video/mp2t"]
};

export type WorkspaceReadResult = ReadFileResult & {
  sourceKind: "text" | "pdf" | "docx";
  mimeType: string;
  extractedBytes?: number;
  pageCount?: number;
  warnings?: string[];
};

export type TransferKind = "image" | "audio" | "video" | "binary";

export interface TransferFileResult {
  path: string;
  mimeType: string;
  extension: string;
  kind: TransferKind;
  bytes: number;
  sha256: string;
  data: string;
  uri: string;
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function withLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const suffix = `\n...[output truncated at ${maxBytes} bytes]`;
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentLimit) low = middle;
    else high = middle - 1;
  }
  return { text: `${value.slice(0, low)}${suffix}`, truncated: true };
}

function mimeForTextPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

async function detectedMime(absPath: string): Promise<string | undefined> {
  try {
    return (await fileTypeFromFile(absPath))?.mime.toLowerCase();
  } catch {
    return undefined;
  }
}

function validateDocumentSize(config: CodexProConfig, bytes: number): void {
  if (bytes > config.maxTransferBytes) {
    throw new CodexProError(`Document is too large (${bytes} bytes). Limit: ${config.maxTransferBytes} bytes.`);
  }
}

function shapeExtractedText(
  rawText: string,
  fileBytes: number,
  sha256: string,
  relPath: string,
  sourceKind: "pdf" | "docx",
  mimeType: string,
  maxBytes: number,
  options: { startLine?: number; endLine?: number; pageCount?: number; warnings?: string[] }
): WorkspaceReadResult {
  const allLines = splitLines(rawText);
  const totalLines = allLines.length;
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const endLine = Math.min(totalLines, Math.floor(options.endLine ?? totalLines));
  if (startLine > totalLines) {
    throw new CodexProError(`start_line (${startLine}) exceeds document line count (${totalLines}).`);
  }
  if (endLine < startLine) {
    throw new CodexProError(`end_line (${endLine}) must be >= start_line (${startLine}).`);
  }
  const numbered = withLineNumbers(allLines.slice(startLine - 1, endLine), startLine);
  const bounded = truncateUtf8(numbered, maxBytes);
  return {
    path: relPath,
    text: bounded.text,
    startLine,
    endLine,
    totalLines,
    bytes: fileBytes,
    sha256,
    truncated: bounded.truncated || startLine > 1 || endLine < totalLines,
    sourceKind,
    mimeType,
    extractedBytes: Buffer.byteLength(rawText, "utf8"),
    pageCount: options.pageCount,
    warnings: options.warnings
  };
}

async function readPdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, pageCount: result.total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexProError(`Unable to extract PDF text: ${message}`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function readDocx(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value,
      warnings: result.messages.map((message) => message.message).filter(Boolean)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexProError(`Unable to extract DOCX text: ${message}`);
  }
}

export async function readWorkspaceFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<WorkspaceReadResult> {
  const resolved = guard.resolve(workspace, filePath);
  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);

  const extension = path.extname(resolved.relPath).toLowerCase();
  const mimeType = await detectedMime(resolved.absPath);
  const extensionClaimsPdf = extension === ".pdf";
  const extensionClaimsDocx = extension === ".docx";
  if (extensionClaimsPdf && mimeType !== PDF_MIME) {
    throw new CodexProError(`File extension .pdf does not match detected type ${mimeType ?? "unknown"}.`);
  }
  if (extensionClaimsDocx && mimeType !== DOCX_MIME && mimeType !== "application/zip") {
    throw new CodexProError(`File extension .docx does not match detected type ${mimeType ?? "unknown"}.`);
  }

  const maxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  if (mimeType === PDF_MIME) {
    validateDocumentSize(config, stat.size);
    const buffer = await fsp.readFile(resolved.absPath);
    const extracted = await readPdf(buffer);
    const warnings = extracted.text.trim() ? [] : ["No extractable PDF text was found. OCR is not enabled."];
    return shapeExtractedText(extracted.text, buffer.byteLength, hashBuffer(buffer), resolved.relPath, "pdf", PDF_MIME, maxBytes, {
      startLine: options.startLine,
      endLine: options.endLine,
      pageCount: extracted.pageCount,
      warnings
    });
  }
  if (mimeType === DOCX_MIME || (extensionClaimsDocx && mimeType === "application/zip")) {
    validateDocumentSize(config, stat.size);
    const buffer = await fsp.readFile(resolved.absPath);
    const extracted = await readDocx(buffer);
    if (!extracted.text.trim()) extracted.warnings.push("No extractable DOCX text was found.");
    return shapeExtractedText(extracted.text, buffer.byteLength, hashBuffer(buffer), resolved.relPath, "docx", DOCX_MIME, maxBytes, {
      startLine: options.startLine,
      endLine: options.endLine,
      warnings: extracted.warnings
    });
  }

  const text = await readTextFile(config, guard, workspace, filePath, options);
  return { ...text, sourceKind: "text", mimeType: mimeForTextPath(text.path) };
}

class TransferSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function classifyTransfer(mimeType: string): TransferKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "binary";
}

function validateExtensionMime(relPath: string, mimeType: string): void {
  const extension = path.extname(relPath).toLowerCase();
  const expected = EXPECTED_MIME_BY_EXTENSION[extension];
  if (expected && !expected.includes(mimeType)) {
    throw new CodexProError(`File extension ${extension} does not match detected MIME type ${mimeType}.`);
  }
}

export class WorkspaceFileTransfer {
  private readonly semaphore: TransferSemaphore;
  private readonly allowedMimeTypes: Set<string>;

  constructor(private readonly config: CodexProConfig) {
    this.semaphore = new TransferSemaphore(config.maxActiveTransfers);
    this.allowedMimeTypes = new Set([...BUILT_IN_TRANSFER_MIME_TYPES, ...config.transferExtraMimeTypes]);
  }

  async transfer(
    guard: PathGuard,
    workspace: Workspace,
    filePath: string,
    requestedMaxBytes?: number
  ): Promise<TransferFileResult> {
    const resolved = guard.resolve(workspace, filePath);
    const stat = await fsp.stat(resolved.absPath);
    if (!stat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);
    if (stat.size === 0) throw new CodexProError(`Cannot transfer an empty file: ${resolved.relPath}`);

    const maxBytes = Math.min(requestedMaxBytes ?? this.config.maxTransferBytes, this.config.maxTransferBytes);
    if (stat.size > maxBytes) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Transfer limit: ${maxBytes} bytes.`);
    }

    const type = await fileTypeFromFile(resolved.absPath).catch(() => undefined);
    if (!type?.mime) {
      throw new CodexProError("Unable to detect a supported binary MIME type. Use read for text documents.");
    }
    const mimeType = type.mime.toLowerCase();
    validateExtensionMime(resolved.relPath, mimeType);
    if (!this.allowedMimeTypes.has(mimeType)) {
      throw new CodexProError(`MIME type is not allowed for transfer: ${mimeType}.`);
    }

    return this.semaphore.run(async () => {
      const buffer = await fsp.readFile(resolved.absPath);
      if (buffer.byteLength > maxBytes) {
        throw new CodexProError(`File grew beyond the transfer limit while being read (${buffer.byteLength} bytes).`);
      }
      const encodedPath = resolved.relPath.split("/").map(encodeURIComponent).join("/");
      return {
        path: resolved.relPath,
        mimeType,
        extension: type.ext,
        kind: classifyTransfer(mimeType),
        bytes: buffer.byteLength,
        sha256: hashBuffer(buffer),
        data: buffer.toString("base64"),
        uri: `codexpro://workspace/${encodeURIComponent(workspace.id)}/file/${encodedPath}`
      };
    });
  }
}
