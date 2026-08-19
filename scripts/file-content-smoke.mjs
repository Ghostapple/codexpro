import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { loadConfig } from '../dist/config.js';
import { readWorkspaceFile, WorkspaceFileTransfer } from '../dist/fileContentOps.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';

function makePdf(text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 16 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function expectFailure(operation, pattern) {
  await assert.rejects(operation, pattern);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexprov4-file-content-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSIAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(256).fill(0)]);
const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(64)]);
const docx = await makeDocx('DOCX transfer smoke text');
const longDocx = await makeDocx(`Long DOCX ${'x'.repeat(5000)}`);
const pdf = makePdf('PDF transfer smoke text');

await Promise.all([
  fs.writeFile(path.join(root, 'note.md'), '# Markdown smoke\n\nReadable text.\n'),
  fs.writeFile(path.join(root, 'sample.pdf'), pdf),
  fs.writeFile(path.join(root, 'sample.docx'), docx),
  fs.writeFile(path.join(root, 'long.docx'), longDocx),
  fs.writeFile(path.join(root, 'sample.png'), png),
  fs.writeFile(path.join(root, 'sample.jpg'), jpeg),
  fs.writeFile(path.join(root, 'sample.mp3'), mp3),
  fs.writeFile(path.join(root, 'sample.mp4'), mp4),
  fs.writeFile(path.join(root, 'fake.png'), mp3),
  fs.writeFile(path.join(root, 'plain.txt'), 'use read instead\n')
]);

const oldEnv = {
  root: process.env.CODEXPRO_ROOT,
  allowed: process.env.CODEXPRO_ALLOWED_ROOTS,
  maxTransfer: process.env.CODEXPRO_MAX_TRANSFER_BYTES,
  allowNoToken: process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN
};
process.env.CODEXPRO_ROOT = root;
process.env.CODEXPRO_ALLOWED_ROOTS = root;
process.env.CODEXPRO_MAX_TRANSFER_BYTES = '4096';
process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = '1';

try {
  const config = loadConfig([]);
  const workspaces = new WorkspaceManager(config);
  const workspace = workspaces.defaultWorkspace();
  const guard = new PathGuard(config);
  const transfer = new WorkspaceFileTransfer(config);

  const markdown = await readWorkspaceFile(config, guard, workspace, 'note.md');
  assert.equal(markdown.sourceKind, 'text');
  assert.equal(markdown.mimeType, 'text/markdown');
  assert.match(markdown.text, /Markdown smoke/);

  const pdfRead = await readWorkspaceFile(config, guard, workspace, 'sample.pdf');
  assert.equal(pdfRead.sourceKind, 'pdf');
  assert.equal(pdfRead.pageCount, 1);
  assert.match(pdfRead.text, /PDF transfer smoke text/);

  const docxRead = await readWorkspaceFile(config, guard, workspace, 'sample.docx');
  assert.equal(docxRead.sourceKind, 'docx');
  assert.match(docxRead.text, /DOCX transfer smoke text/);

  const boundedDocx = await readWorkspaceFile(config, guard, workspace, 'long.docx', { maxBytes: 1000 });
  assert.equal(boundedDocx.truncated, true);
  assert.ok(Buffer.byteLength(boundedDocx.text, 'utf8') <= 1000, 'document output exceeded maxBytes');

  for (const [file, kind, expected] of [
    ['sample.png', 'image', png],
    ['sample.jpg', 'image', jpeg],
    ['sample.mp3', 'audio', mp3],
    ['sample.mp4', 'video', mp4]
  ]) {
    const result = await transfer.transfer(guard, workspace, file);
    assert.equal(result.kind, kind);
    assert.deepEqual(Buffer.from(result.data, 'base64'), expected);
    assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'));
  }

  await expectFailure(() => transfer.transfer(guard, workspace, 'fake.png'), /does not match detected MIME/);
  await expectFailure(() => transfer.transfer(guard, workspace, 'plain.txt'), /Use read for text documents/);
  await expectFailure(() => transfer.transfer(guard, workspace, '.env'), /blocked by safety rules/);

  const oversized = Buffer.concat([mp4, Buffer.alloc(4096)]);
  await fs.writeFile(path.join(root, 'oversized.mp4'), oversized);
  await expectFailure(() => transfer.transfer(guard, workspace, 'oversized.mp4'), /File is too large/);

  console.log('file content smoke test passed');
} finally {
  if (oldEnv.root === undefined) delete process.env.CODEXPRO_ROOT; else process.env.CODEXPRO_ROOT = oldEnv.root;
  if (oldEnv.allowed === undefined) delete process.env.CODEXPRO_ALLOWED_ROOTS; else process.env.CODEXPRO_ALLOWED_ROOTS = oldEnv.allowed;
  if (oldEnv.maxTransfer === undefined) delete process.env.CODEXPRO_MAX_TRANSFER_BYTES; else process.env.CODEXPRO_MAX_TRANSFER_BYTES = oldEnv.maxTransfer;
  if (oldEnv.allowNoToken === undefined) delete process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN; else process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = oldEnv.allowNoToken;
  await fs.rm(root, { recursive: true, force: true });
}
