#!/usr/bin/env node

import { runCaptureFromCli } from './src/capture/index.js';

runCaptureFromCli().catch((err) => {
  console.error('[capture] 启动失败:', err);
  process.exit(1);
});
