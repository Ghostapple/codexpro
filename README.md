<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexProV4 logo">
</p>

<h1 align="center">CodexProV4</h1>

<p align="center">
  将 ChatGPT / MCP 客户端安全连接到本地工作区，并支持受控的文档读取与图片、音频、视频文件传输。
</p>

> 当前版本：`0.30.0`。本仓库基于 CodexPro 演进，保留原有代码检索、编辑、Shell、变更审查和 handoff 能力，并增加 V4 文件内容能力与 Windows 一键启动链。

## 核心能力

| 能力 | 支持范围 | 说明 |
| --- | --- | --- |
| 工作区读写 | 文件树、搜索、读取、编辑、补丁、Git 变更 | 所有路径仍受工作区边界和阻止路径规则约束 |
| 文档读取 | 文本、Markdown、PDF、DOCX | `read` 返回有界、带行号的提取文本，不直接返回整份二进制 |
| 图片传输 | PNG、JPEG、WebP、GIF、BMP、TIFF | `transfer_file` 返回 MCP 图片内容块 |
| 音频传输 | MP3、WAV、M4A、AAC、OGG、FLAC | 传输文件本身，不等同于自动转写 |
| 视频传输 | MP4、WebM、MOV、M4V、MPEG、TS | 传输文件本身，不自动抽帧或理解视频语义 |
| 公网连接 | Cloudflare、ngrok、Tailscale Funnel | 公网模式必须使用 CodexPro URL 令牌 |
| Windows 一键启动 | 桌面 EXE + PowerShell 常驻启动器 | 监听 `8788`；HTTP 子服务掉线后自动清理并恢复 |

V4 会检查扩展名与实际 MIME/魔数是否一致，默认单文件传输上限为 `50 MiB`、并发数为 `1`，并返回 SHA-256 元数据。二进制 base64 位于 MCP `content`，不会塞进 `structuredContent`。

## 运行要求

- Node.js `>= 22.3.0`
- npm
- 需要公网访问时安装对应隧道程序
- 使用 Windows 一键启动时，需要 Tailscale、MagicDNS、HTTPS 证书及 Funnel 权限
- ChatGPT 侧需要能够创建 Developer Mode App / MCP 连接

## 从源码快速启动

```powershell
git clone https://github.com/Ghostapple/codexpro.git
cd codexpro
npm ci
npm run build
```

仅本机启动，工作区为 `D:\work`：

```powershell
node scripts\codexpro.mjs start --root=D:\work --port=8788 --tunnel=none --bash=full
```

本地状态页和 MCP 地址：

```text
http://127.0.0.1:8788/
http://127.0.0.1:8788/mcp
```

使用临时 Cloudflare 地址：

```powershell
node scripts\codexpro.mjs start --root=D:\work --port=8788 --tunnel=cloudflare --bash=full
```

启动后终端会输出带 `codexpro_token` 的 Server URL。不要把该 URL、令牌、日志或本地配置提交到 Git。

## 连接 ChatGPT

在 ChatGPT 中打开：

```text
Settings -> Apps -> Advanced settings -> Create app
```

填写启动时输出的完整 Server URL，并选择：

```text
Authentication: No Authentication / None
```

这里的 `None` 只表示 ChatGPT 不额外添加 OAuth；CodexPro 自己仍通过 URL 中的私有令牌鉴权。稳定地址和令牌没有变化时，升级服务端通常不需要重建插件；新对话或重新连接会刷新工具列表。

## Windows 桌面一键启动

仓库内包含可复用且不硬编码令牌的启动链：

```text
scripts/windows/install-desktop-launcher.ps1
  -> %USERPROFILE%\.codexpro\bin\start-codexprov4-tailscale.ps1
  -> node scripts\codexpro.mjs tailscale
  -> CodexProV4 HTTP :8788
  -> Tailscale Funnel
```

### 1. 安装 Tailscale 并确认已登录

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' status
```

### 2. 运行安装器

在管理员权限不是必需的普通 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-desktop-launcher.ps1 `
  -CodexProRoot 'D:\work\codexprov4' `
  -WorkspaceRoot 'D:\work' `
  -Hostname 'your-device.your-tailnet.ts.net' `
  -Port 8788
```

首次安装会在终端中安全提示输入 CodexPro 令牌；输入内容不会回显。安装器会：

1. 把启动器源码复制到 `%USERPROFILE%\.codexpro\bin`。
2. 把非敏感配置写入 `%USERPROFILE%\.codexpro\config`。
3. 把令牌单独写入 `%USERPROFILE%\.codexpro\secrets`。
4. 使用 Windows 自带 C# 编译器生成桌面 `CodexPro.exe`。
5. 覆盖桌面 EXE 前，将旧版本备份到 `%USERPROFILE%\.codexpro\backups`。

若令牌文件已经存在，安装器默认复用，不会输出或覆盖它。需要换令牌时，先手动删除：

```text
%USERPROFILE%\.codexpro\secrets\codexpro-tailscale-token.txt
```

然后重新运行安装器。

### 3. 启动与日志

双击桌面 `CodexPro.exe`。启动器会固定使用 `8788`，并监控 HTTP 监听；若管理进程仍在但 HTTP 子进程掉线，会清理该启动器创建的进程树并自动恢复。

日志位置：

```text
%USERPROFILE%\.codexpro\logs\codexpro-tailscale-autostart.log
%USERPROFILE%\.codexpro\logs\codexprov4-*.out.log
%USERPROFILE%\.codexpro\logs\codexprov4-*.err.log
```

固定 MCP 地址格式：

```text
https://your-device.your-tailnet.ts.net/mcp?codexpro_token=<private-token>
```

## 文件读取与传输示例

读取文本、PDF 或 DOCX：

```json
{
  "path": "docs/report.pdf",
  "max_bytes": 120000
}
```

向支持多模态内容块的 MCP 客户端传输图片、音频或视频：

```json
{
  "path": "assets/demo.mp4"
}
```

安全限制：

- 路径必须位于允许的工作区内。
- 符号链接、阻止路径和秘密文件仍受现有路径策略约束。
- 扩展名伪装、未知 MIME、空文件、超限文件会被拒绝。
- `max_bytes` 只能降低单次传输上限，不能突破服务端上限。
- 客户端或模型是否能理解音视频，取决于它是否支持相应 MCP 内容块。

相关环境变量：

```text
CODEXPRO_MAX_READ_BYTES=180000
CODEXPRO_MAX_TRANSFER_BYTES=52428800
CODEXPRO_MAX_ACTIVE_TRANSFERS=1
CODEXPRO_TRANSFER_EXTRA_MIME_TYPES=
```

## 常用命令

```powershell
node scripts\codexpro.mjs doctor
node scripts\codexpro.mjs settings
node scripts\codexpro.mjs start --no-bash
node scripts\codexpro.mjs start --tool-mode=minimal
node scripts\codexpro.mjs start --mode=handoff
```

原生 Windows Shell：

```powershell
node scripts\codexpro.mjs start --powershell
node scripts\codexpro.mjs start --cmd
node scripts\codexpro.mjs settings set --shell powershell
```

## 安全边界

- CodexProV4 是本地工作区 MCP 桥接器，不是模型代理、账号池、配额绕过工具或托管服务。
- 公网隧道必须开启 CodexPro 令牌；不要将真实令牌写进源码、README、Issue 或日志截图。
- `write`、`edit` 和 `apply_patch` 仍受写入模式、工作区边界、阻止路径和秘密内容检查约束。
- `bash=full` 会把命令交给所选本地 Shell；仅对可信客户端和可信工作区开启。
- 部署前请阅读 [SECURITY.md](SECURITY.md)。

## 验证与开发

安装依赖后运行：

```powershell
npm run build
npm run smoke:file-content
npm run smoke
```

远程隧道冒烟测试会临时创建服务和隧道，仅在确实需要公网验收时运行：

```powershell
npm run smoke:remote
```

发布前建议：

```powershell
npm audit --audit-level=high
npm pack --dry-run
git diff --check
```

## 故障排查

- **双击无反应**：检查 `8788` 是否监听，并查看 `codexpro-tailscale-autostart.log`。新版启动器会自动处理“CLI 存活但 HTTP 子进程已退出”的情况。
- **插件连不上**：先验证本地带令牌 `/healthz`，再检查 Tailscale Funnel 是否仍转发到 `127.0.0.1:8788`。
- **看到 401**：说明服务可达但令牌缺失或不匹配；使用完整 Server URL。
- **工具列表还是旧的**：新建对话或断开后重新连接 App；稳定 URL/令牌没变时通常无需重建 App。
- **端口占用**：确认占用进程确实属于 CodexPro 后再终止，或显式换端口。
- **PDF/DOCX 为空**：确认文件不是扫描图片或加密文档；V4 不内置 OCR。

## 项目文件

- [README_V4.md](README_V4.md)：V4 增量能力摘要
- [PROJECTS.md](PROJECTS.md)：已完成、待办和后续方向
- [SECURITY.md](SECURITY.md)：安全模型
- [FAQ.md](FAQ.md)：常见问题
- [DOMAIN_SETUP.md](DOMAIN_SETUP.md)：稳定域名和隧道
- [PUBLIC_LAUNCH_CHECKLIST.md](PUBLIC_LAUNCH_CHECKLIST.md)：公开连接检查清单

本项目保留原 CodexPro 的 MIT License 与上游署名。
