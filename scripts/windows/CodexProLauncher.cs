using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Windows.Forms;

internal static class CodexProLauncher
{
    private static readonly string InstallRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".codexpro"
    );

    [STAThread]
    private static void Main()
    {
        try
        {
            var scriptPath = Path.Combine(InstallRoot, "bin", "start-codexprov4-tailscale.ps1");
            var hostname = ReadSetting("hostname");
            var port = int.Parse(ReadSetting("port"));
            var tokenPath = Path.Combine(InstallRoot, "secrets", "codexpro-tailscale-token.txt");
            var token = File.ReadAllText(tokenPath).Trim();
            var publicUrl = "https://" + hostname + "/mcp?codexpro_token=" + Uri.EscapeDataString(token);

            if (IsListening(port))
            {
                TryCopy(publicUrl);
                MessageBox.Show(
                    "CodexProV4 已在运行。MCP 地址已复制到剪贴板。\n\n" + publicUrl,
                    "CodexProV4",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            if (!File.Exists(scriptPath))
            {
                throw new FileNotFoundException("启动脚本不存在，请重新运行安装器。", scriptPath);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + scriptPath + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(startInfo);
            TryCopy(publicUrl);
            MessageBox.Show(
                "CodexProV4 正在启动或恢复。MCP 地址已复制到剪贴板。\n\n" + publicUrl,
                "CodexProV4",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "CodexProV4 启动失败：\n\n" + error.Message,
                "CodexProV4",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private static string ReadSetting(string name)
    {
        var path = Path.Combine(InstallRoot, "config", name + ".txt");
        if (!File.Exists(path)) throw new FileNotFoundException("缺少启动配置，请重新运行安装器。", path);
        var value = File.ReadAllText(path).Trim();
        if (value.Length == 0) throw new InvalidDataException("启动配置为空：" + path);
        return value;
    }

    private static void TryCopy(string value)
    {
        try { Clipboard.SetText(value); } catch { }
    }

    private static bool IsListening(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var result = client.BeginConnect("127.0.0.1", port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(300))) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }
}
