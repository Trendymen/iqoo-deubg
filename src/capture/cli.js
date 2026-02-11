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
    pingInterval: z.coerce.number().positive().optional()
  }).parse(opts);
  return {
    minutes: parsed.minutes,
    out: parsed.out,
    config: parsed.config,
    hostPing: parsed.hostPing,
    hostIp: parsed.hostIp || '',
    pingInterval: parsed.pingInterval
  };
}
