# CodexProV4

CodexProV4 is an isolated CodexProV3-derived MCP server for bounded workspace file access.

完整安装、ChatGPT 连接、Windows 桌面一键启动、安全边界和故障排查请阅读 [README.md](README.md)。

## Added in v4

- Existing `read` support for UTF-8 text plus extracted text from PDF and DOCX documents.
- A read-only `transfer_file` tool for approved image, audio, and video MIME types.
- A default 50 MiB transfer cap, magic-byte MIME checks, SHA-256 metadata, and bounded transfer concurrency.
- Default HTTP port `8788`, allowing CodexProV3 to remain on `8787`.

Audio and video are transferred as MCP content; CodexProV4 does not transcribe audio, extract video frames, perform OCR, or claim that every client/model can semantically understand those files.

## Run

```powershell
$env:CODEXPRO_HOME='D:\work\.codexpro-v4'
node dist\http.js --root=D:\work --port=8788
```

Then open `http://127.0.0.1:8788/` and connect an MCP client to `http://127.0.0.1:8788/mcp`.

## Windows one-click launcher

The repository ships a secret-free launcher template and installer under `scripts/windows/`. The installer stores the token outside the checkout, compiles `CodexPro.exe`, targets port `8788`, and installs a self-healing Tailscale launcher.
