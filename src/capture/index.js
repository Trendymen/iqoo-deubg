import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { parseCaptureArgs, printCaptureHelp } from './cli.js';
import { ensureAdbAndPickDevice } from './environment.js';
import { runCaptureFlow } from './runner.js';
import { readJsonIfExists } from '../shared/io.js';

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const TZ_OFFSET_REGEX = /^[+-](\d{2}):(\d{2})$/;

function normalizeIntervalSec(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
}

function assertIpv4(value, label) {
  if (!IPV4_REGEX.test(value)) {
    throw new Error(`${label} 格式无效: ${value}（仅支持 IPv4）。`);
  }
}

function parseAndValidateTzOffset(rawOffset) {
  const text = String(rawOffset || '').trim();
  const m = text.match(TZ_OFFSET_REGEX);
  if (!m) {
    throw new Error(`ping 日志时区偏移格式无效: ${text}（示例: +08:00）`);
  }
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const totalMinutes = hours * 60 + minutes;
  if (totalMinutes > 14 * 60) {
    throw new Error(`ping 日志时区偏移超出范围: ${text}`);
  }
  return text;
}

function resolveHostPingConfig(args, rawConfig, configPath) {
  const cfgHostPing = rawConfig.hostPing || {};

  const enabled = Boolean(args.hostPing || args.hostIp || cfgHostPing.enabled);
  const hostIp = String(args.hostIp || cfgHostPing.hostIp || '').trim();
  const intervalSec = normalizeIntervalSec(args.pingInterval ?? cfgHostPing.intervalSec ?? 0.2, 0.2);

  if (!enabled) {
    return {
      enabled: false,
      hostIp: '',
      intervalSec: 0.2,
      configPath
    };
  }

  if (!hostIp) {
    throw new Error(`已启用 host ping，但未配置 host IP。请在 ${configPath} 设置 hostPing.hostIp，或传 --host-ip。`);
  }
  assertIpv4(hostIp, 'host IP');

  return {
    enabled: true,
    hostIp,
    intervalSec,
    configPath
  };
}

function resolveHostSidePingConfig(args, rawConfig, configPath) {
  const cfgHostSidePing = rawConfig.hostSidePing || {};
  const enabled = Boolean(
    args.hostSidePing
    || args.hostSideIp
    || args.hostSideSshHost
    || args.hostSideSshUser
    || args.hostSideSshKey
    || cfgHostSidePing.enabled
  );

  if (!enabled) {
    return {
      enabled: false,
      hostIp: '',
      intervalSec: 0.2,
      sshHost: '',
      sshPort: 22,
      sshUser: '',
      sshKeyPath: '',
      remoteScriptDir: 'C:\\iqoo-ping',
      configPath
    };
  }

  const hostIp = String(args.hostSideIp || cfgHostSidePing.hostIp || '').trim();
  const intervalSec = normalizeIntervalSec(args.hostSideInterval ?? cfgHostSidePing.intervalSec ?? 0.2, 0.2);
  const sshHost = String(args.hostSideSshHost || cfgHostSidePing.sshHost || '').trim();
  const sshPortRaw = Number(args.hostSideSshPort ?? cfgHostSidePing.sshPort ?? 22);
  const sshUser = String(args.hostSideSshUser || cfgHostSidePing.sshUser || '').trim();
  const sshKeyInput = String(args.hostSideSshKey || cfgHostSidePing.sshKeyPath || '').trim();
  const remoteScriptDir = String(cfgHostSidePing.remoteScriptDir || 'C:\\iqoo-ping').trim() || 'C:\\iqoo-ping';

  if (!hostIp) {
    throw new Error(`已启用 host-side ping，但未配置 hostSidePing.hostIp。请在 ${configPath} 设置 hostSidePing.hostIp，或传 --host-side-ip。`);
  }
  assertIpv4(hostIp, 'host-side ping 目标 IP');

  if (!sshHost) {
    throw new Error(`已启用 host-side ping，但未配置 SSH 主机。请在 ${configPath} 设置 hostSidePing.sshHost，或传 --host-side-ssh-host。`);
  }
  if (!Number.isFinite(sshPortRaw) || sshPortRaw <= 0 || sshPortRaw > 65535) {
    throw new Error(`host-side SSH 端口无效: ${sshPortRaw}`);
  }
  if (!sshUser) {
    throw new Error(`已启用 host-side ping，但未配置 SSH 用户。请在 ${configPath} 设置 hostSidePing.sshUser，或传 --host-side-ssh-user。`);
  }
  if (!sshKeyInput) {
    throw new Error(`已启用 host-side ping，但未配置 SSH 私钥。请在 ${configPath} 设置 hostSidePing.sshKeyPath，或传 --host-side-ssh-key。`);
  }
  const sshKeyExpanded = sshKeyInput.startsWith('~/')
    ? path.join(process.env.HOME || '', sshKeyInput.slice(2))
    : sshKeyInput;
  const sshKeyPath = path.resolve(sshKeyExpanded);
  if (!fs.existsSync(sshKeyPath)) {
    throw new Error(`host-side SSH 私钥文件不存在: ${sshKeyPath}`);
  }

  return {
    enabled: true,
    hostIp,
    intervalSec,
    sshHost,
    sshPort: sshPortRaw,
    sshUser,
    sshKeyPath,
    remoteScriptDir,
    configPath
  };
}

function resolvePingLogTzOffset(args, rawConfig) {
  const cfgOffset = rawConfig.pingLogTzOffset;
  const offset = String(args.pingLogTzOffset || cfgOffset || '+08:00').trim();
  return parseAndValidateTzOffset(offset);
}

export async function runCaptureFromCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCaptureArgs(argv);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('[capture] 参数错误:', err.issues.map((x) => x.message).join('; '));
      printCaptureHelp();
      process.exit(1);
      return;
    }
    throw err;
  }

  const configPath = path.resolve(args.config || './capture.config.json');
  const rawConfig = readJsonIfExists(configPath) || {};

  let hostPing;
  let hostSidePing;
  let pingLogTzOffset;
  try {
    hostPing = resolveHostPingConfig(args, rawConfig, configPath);
    hostSidePing = resolveHostSidePingConfig(args, rawConfig, configPath);
    pingLogTzOffset = resolvePingLogTzOffset(args, rawConfig);
  } catch (err) {
    console.error('[capture]', err.message);
    process.exit(1);
    return;
  }

  let env;
  try {
    env = await ensureAdbAndPickDevice();
  } catch (err) {
    console.error('[capture]', err.message);
    process.exit(1);
    return;
  }

  await runCaptureFlow({
    minutes: args.minutes,
    out: args.out,
    serial: env.serial,
    devices: env.devices,
    hostPing,
    hostSidePing,
    pingLogTzOffset
  });
}
