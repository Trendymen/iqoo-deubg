import { Command } from 'commander';
import { z } from 'zod';

function createCaptureProgram() {
  return new Command()
    .name('capture')
    .description('采集 Android Wi-Fi/网络/Doze 日志')
    .option('--minutes <number>', '采集时长（分钟）', '15')
    .option('--out <dir>', '输出根目录', './logs')
    .option('--config <path>', '采集配置文件（JSON）', './capture.config.json')
    .option('--host-ping', '启用主机延迟连续采样（adb shell ping）', false)
    .option('--host-ip <ip>', '主机 IP（Sunshine 主机或路由器 LAN IP）')
    .option('--ping-interval <seconds>', 'ping 采样间隔（秒）')
    .option('--host-side-ping', '启用 Windows 主机侧协同 ping（经 SSH）', false)
    .option('--host-side-ip <ip>', '主机侧 ping 目标 IP（通常为手机 Wi-Fi IP）')
    .option('--host-side-interval <seconds>', '主机侧 ping 采样间隔（秒）')
    .option('--host-side-ssh-host <host>', 'Windows 主机 SSH 地址')
    .option('--host-side-ssh-port <port>', 'Windows 主机 SSH 端口')
    .option('--host-side-ssh-user <user>', 'Windows 主机 SSH 用户')
    .option('--host-side-ssh-key <path>', 'Windows 主机 SSH 私钥路径')
    .option('--ping-log-tz-offset <offset>', 'ping 日志时区偏移（例如 +08:00）', '+08:00')
    .helpOption('-h, --help', '显示帮助');
}

export function printCaptureHelp() {
  createCaptureProgram().outputHelp();
}

export function parseCaptureArgs(argv) {
  const program = createCaptureProgram();
  program.parse(argv, { from: 'user' });
  const opts = program.opts();
  const parsed = z.object({
    minutes: z.coerce.number().positive(),
    out: z.string().min(1),
    config: z.string().min(1),
    hostPing: z.boolean().default(false),
    hostIp: z.string().optional(),
    pingInterval: z.coerce.number().positive().optional(),
    hostSidePing: z.boolean().default(false),
    hostSideIp: z.string().optional(),
    hostSideInterval: z.coerce.number().positive().optional(),
    hostSideSshHost: z.string().optional(),
    hostSideSshPort: z.coerce.number().int().positive().optional(),
    hostSideSshUser: z.string().optional(),
    hostSideSshKey: z.string().optional(),
    pingLogTzOffset: z.string().min(1).default('+08:00')
  }).parse(opts);
  return {
    minutes: parsed.minutes,
    out: parsed.out,
    config: parsed.config,
    hostPing: parsed.hostPing,
    hostIp: parsed.hostIp || '',
    pingInterval: parsed.pingInterval,
    hostSidePing: parsed.hostSidePing,
    hostSideIp: parsed.hostSideIp || '',
    hostSideInterval: parsed.hostSideInterval,
    hostSideSshHost: parsed.hostSideSshHost || '',
    hostSideSshPort: parsed.hostSideSshPort,
    hostSideSshUser: parsed.hostSideSshUser || '',
    hostSideSshKey: parsed.hostSideSshKey || '',
    pingLogTzOffset: parsed.pingLogTzOffset
  };
}
