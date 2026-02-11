import { Command } from 'commander';
import { z } from 'zod';

function createReportProgram() {
  return new Command()
    .name('parse_report')
    .description('解析日志并生成报告')
    .option('--dir <path>', '日志目录')
    .option('--latest', '使用 logs 下最新目录', false)
    .option('--stream-window-mode <mode>', '串流窗口模式：auto|strict|all', 'auto')
    .option('--noise-policy <policy>', '降噪策略：balanced|aggressive|conservative', 'balanced')
    .option('--session-pre-buffer-sec <sec>', '会话前置缓冲秒数', '5')
    .option('--session-post-buffer-sec <sec>', '会话后置缓冲秒数', '10')
    .option('--clock-skew-tolerance-sec <sec>', '时钟偏移容差秒数', '2')
    .option('--no-valid-session-policy <policy>', '无有效会话策略：empty-main|degraded', 'empty-main')
    .helpOption('-h, --help', '显示帮助');
}

export function printReportHelp() {
  createReportProgram().outputHelp();
}

export function parseReportArgs(argv) {
  const program = createReportProgram();
  program.parse(argv, { from: 'user' });
  const opts = program.opts();
  const parsed = z.object({
    dir: z.string().optional(),
    latest: z.boolean().default(false),
    streamWindowMode: z.enum(['auto', 'strict', 'all']).default('auto'),
    noisePolicy: z.enum(['balanced', 'aggressive', 'conservative']).default('balanced'),
    sessionPreBufferSec: z.coerce.number().nonnegative().default(5),
    sessionPostBufferSec: z.coerce.number().nonnegative().default(10),
    clockSkewToleranceSec: z.coerce.number().nonnegative().default(2),
    noValidSessionPolicy: z.enum(['empty-main', 'degraded']).default('empty-main')
  }).parse(opts);
  return {
    dir: parsed.dir || '',
    latest: parsed.latest,
    streamWindowMode: parsed.streamWindowMode,
    noisePolicy: parsed.noisePolicy,
    sessionPreBufferSec: parsed.sessionPreBufferSec,
    sessionPostBufferSec: parsed.sessionPostBufferSec,
    clockSkewToleranceSec: parsed.clockSkewToleranceSec,
    noValidSessionPolicy: parsed.noValidSessionPolicy
  };
}
