#!/usr/bin/env node

import { runReportFromCli } from './src/report/index.js';

runReportFromCli().catch((err) => {
  console.error('[report] 执行失败:', err);
  process.exit(1);
});
