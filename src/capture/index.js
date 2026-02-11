import path from 'node:path';
import { ZodError } from 'zod';
import { parseCaptureArgs, printCaptureHelp } from './cli.js';
import { ensureAdbAndPickDevice } from './environment.js';
import { runCaptureFlow } from './runner.js';
import { readJsonIfExists } from '../shared/io.js';

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function resolveHostPingConfig(args) {
  const configPath = path.resolve(args.config || './capture.config.json');
  const rawConfig = readJsonIfExists(configPath) || {};
  const cfgHostPing = rawConfig.hostPing || {};

  const enabled = Boolean(args.hostPing || args.hostIp || cfgHostPing.enabled);
  const hostIp = String(args.hostIp || cfgHostPing.hostIp || '').trim();
  const intervalSec = Number(args.pingInterval ?? cfgHostPing.intervalSec ?? 0.2);

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
  if (!IPV4_REGEX.test(hostIp)) {
    throw new Error(`host IP 格式无效: ${hostIp}（仅支持 IPv4）。`);
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new Error(`ping interval 无效: ${intervalSec}`);
  }

  return {
    enabled: true,
    hostIp,
    intervalSec,
    configPath
  };
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

  let hostPing;
  try {
    hostPing = resolveHostPingConfig(args);
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
    hostPing
  });
}
