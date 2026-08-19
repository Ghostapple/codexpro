# PROJECTS

## Goal

Deliver an independently runnable CodexProV4 that reads workspace text/PDF/DOCX content and transfers approved image, audio, and video files to MCP clients without changing CodexProV3.

## Completed

- Created the isolated `D:\work\codexprov4` baseline from CodexProV3 without copying dependencies, builds, logs, or runtime state.
- Updated package identity to CodexProV4 `0.30.0` and reserved port `8788` for side-by-side launch.
- Added project rules and this live project tracker.
- Extended `read` to extract bounded, line-numbered text from PDF and DOCX while preserving the existing text/Markdown path and secret redaction.
- Added the read-only `transfer_file` MCP tool with magic-byte MIME checks, image/audio/resource content blocks, SHA-256 metadata, a 50 MiB default cap, and bounded concurrency.
- Added focused fixtures for text, PDF, DOCX, PNG, JPEG, MP3, and MP4 plus failure coverage for type spoofing and oversize files.
- Passed the focused file-content smoke, stdio MCP smoke, HTTP smoke, Pro CLI smoke, doctor smoke, settings smoke, and handoff execution smoke suites.
- Started the latest build on `127.0.0.1:8788` with workspace root `D:\work` and verified real HTTP MCP reads/transfers for Markdown, PNG, MP3, and MP4.
- Opened and visually verified the CodexProV4 local status page; the service now runs through the persistent desktop/Tailscale launcher on port `8788`.
- Added and passed `smoke:remote`: a temporary token-protected Cloudflare tunnel verified the public `/healthz`, then removed its token, temporary state, server, and tunnel process.

## Next

- Goal achieved. Keep this file updated after future change batches.

## Not completed

- None for the requested v4 file-reading and transfer goal.

## After the goal

- Optional OCR, transcription, chunked artifact delivery, or additional Office formats can be evaluated separately.

## 2026-08-18：桌面一键启动入口

- 已完成：将桌面 `CodexPro.exe` 的启动链切换到 `D:\work\codexprov4`，固定使用端口 `8788`。
- 已完成：同步更新底层 Tailscale 启动脚本和桌面启动器的端口检测。
- 已完成：迁移常驻进程，固定 Tailscale 地址已从旧版 `8787` 切换到 v4 的 `8788`。
- 已验证：本地带令牌 `/healthz` 返回 `200` 且标识为 `CodexProV4`；公网未带令牌请求返回 `401`，证明隧道可达且鉴权生效。
- 已修复：启动脚本不再永久等待残留的 Tailscale/CLI 进程；现在持续监控 `8788`，HTTP 子服务掉线后会清理整棵子进程并自动重启，同时保留独立 stdout/stderr 日志。
- 已验证：主动终止一次 v4 HTTP 子进程后，启动脚本自动换新 PID 恢复，带令牌健康检查和 Tailscale `8788` 转发均重新通过。
- 当前目标：已达成。桌面一键入口、后台服务和固定 MCP 地址均指向 CodexPro v4。
- 后续可做：需要时可为启动器增加托盘状态或“重启服务”入口。

## 2026-08-19：独立仓库、README 与可发布启动器

- 已完成：在 `D:\work\codexprov4` 建立独立 Git 边界并关联 `Ghostapple/codexpro`，避免误提交到父级 `D:\work` 仓库。
- 已完成：重写主 README，覆盖 V4 能力、源码运行、ChatGPT 连接、文件读取/传输、安全边界、验证和故障排查。
- 已完成：新增 `scripts/windows` 可发布启动包，包含无令牌硬编码的 C# 桌面入口、自愈 Tailscale 启动脚本、安装器和图标。
- 已完成：用仓库内安装器升级当前桌面入口；真实服务已通过 `8788`、带令牌健康检查、`D:\work` 根目录和 Tailscale 转发验证。
- 已完成：`npm run build`、完整 `npm run smoke`、安装器语法/编译、npm 打包预览、diff 检查和秘密扫描全部通过。
- 已完成：对仓库内通用启动器执行真实故障注入，HTTP 子进程被终止后自动恢复为新 PID，健康检查与 Tailscale 转发保持正常。
- 当前目标：本批次交付物已就绪，随 CodexProV4 `0.30.0` 发布提交推送到 `Ghostapple/codexpro` 的 `main`。
- 尚未完成：无代码、文档或验证项。
- 后续可做：按需增加托盘状态页、显式重启按钮或 Windows 登录自启动安装选项。
