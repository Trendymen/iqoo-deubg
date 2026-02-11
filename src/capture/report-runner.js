import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsExtra from 'fs-extra';
import { execaNode } from 'execa';

const { pathExists } = fsExtra;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runParseReport(outDir) {
  const parseScript = path.resolve(__dirname, '..', '..', 'parse_report.js');
  if (!(await pathExists(parseScript))) {
    console.error('[capture] 未找到 parse_report.js，跳过自动解析。');
    return 1;
  }
  try {
    const result = await execaNode(parseScript, ['--dir', outDir], {
      stdio: 'inherit',
      reject: false,
      windowsHide: true
    });
    return result.exitCode ?? 1;
  } catch (err) {
    console.error('[capture] 启动 parse_report.js 失败:', err.message);
    return 1;
  }
}
