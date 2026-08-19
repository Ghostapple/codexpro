import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use.`));
    });
    socket.once('error', () => resolve());
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const port = Number(process.env.CODEXPRO_REMOTE_SMOKE_PORT ?? 8789);
const workspaceRoot = path.resolve(process.env.CODEXPRO_REMOTE_SMOKE_ROOT ?? '..');
const cloudflared = process.env.CODEXPRO_CLOUDFLARED ?? 'cloudflared';
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexprov4-remote-smoke-'));
const token = randomBytes(32).toString('hex');
let server;
let tunnel;

try {
  await assertPortFree(port);
  server = spawn(process.execPath, ['dist/http.js', '--root', workspaceRoot, '--allow-root', workspaceRoot, '--port', String(port)], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_HOME: tempRoot,
      CODEXPRO_HTTP_TOKEN: token,
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: '0',
      CODEXPRO_TUNNEL_MODE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverStderr = '';
  server.stderr.on('data', (chunk) => {
    serverStderr += String(chunk);
  });
  await waitFor(
    async () => serverStderr.includes('HTTP MCP listening') || (server.exitCode !== null ? Promise.reject(new Error(serverStderr)) : false),
    15_000,
    'temporary CodexProV4 server startup'
  );

  tunnel = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let tunnelOutput = '';
  tunnel.stdout.on('data', (chunk) => {
    tunnelOutput += String(chunk);
  });
  tunnel.stderr.on('data', (chunk) => {
    tunnelOutput += String(chunk);
  });
  const publicUrl = await waitFor(() => {
    if (tunnel.exitCode !== null) throw new Error(tunnelOutput);
    return tunnelOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  }, 45_000, 'Cloudflare quick tunnel URL');

  const health = await waitFor(async () => {
    let response;
    try {
      response = await fetch(`${publicUrl}/healthz`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      const cause = error?.cause;
      throw new Error(`${error.message}${cause ? ` (${cause.code ?? cause.name ?? 'cause'}: ${cause.message ?? cause})` : ''}`);
    }
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return response.json();
  }, 30_000, 'authenticated public health check');
  if (!health.ok || health.name !== 'CodexProV4' || path.resolve(health.defaultRoot) !== workspaceRoot) {
    throw new Error(`Unexpected public health response: ${JSON.stringify(health)}`);
  }
  console.log(JSON.stringify({ ok: true, name: health.name, root: health.defaultRoot, remoteHost: new URL(publicUrl).host, tokenRetained: false }));
} finally {
  if (tunnel && tunnel.exitCode === null) tunnel.kill('SIGTERM');
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (tunnel) await waitForExit(tunnel);
  if (server) await waitForExit(server);
  await fs.rm(tempRoot, { recursive: true, force: true });
}
