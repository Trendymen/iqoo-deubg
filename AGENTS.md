## AI 代理文件变更规则（强制）

适用对象：Codex、Cursor 等 AI 代理。

1. 新增 / 删除 / 重命名文件时，必须优先使用 AI 内部编辑工具。
2. Codex 必须优先使用 `apply_patch`（`*** Add File` / `*** Delete File` / `*** Move to`）。
3. Cursor 必须优先使用其内置编辑能力（Apply/Edit Patch）。
4. 非必要禁止使用 shell 直接改仓库文件（如 `cat > file << 'EOF'`、`echo ... > file`、`rm`、`mv`）。
5. 仅在内部工具不可用时，才允许临时使用 shell；并且必须在回复中说明原因。
6. 每次任务结束必须输出文件级变更清单，按以下三类列出完整路径：
   - Added
   - Deleted
   - Modified
7. 不允许静默新增或删除文件；最终回复必须明确列出新增/删除的文件。

## 仓库脚本实现目的（本项目）

本仓库用于在 **Android 非 root** 场景下，定位 Moonlight/Sunshine 串流中的周期性网络抖动、瞬时延迟升高与卡顿问题，核心目标如下：

1. 统一采集：通过 `npm run capture` 周期抓取 `logcat + dumpsys(wifi/connectivity/deviceidle/power/alarm/jobscheduler)`，形成同一时间线样本。
2. 延迟连续采样：通过 `npm run capture:ping`（或 `capture.js --host-ping --host-ip <IP>`）在采集同时执行手机侧 `adb shell ping`，记录 `ping_host.log`，用于秒级抖动定位。
3. 串流 App 专项分析：从 `logcat_all.log` 中抽取 Moonlight/LimeLog 相关日志，生成 `app_focus.log` 与 `app_metrics.csv`，提取如连接失败、超时配置、帧同步/延迟等指标。
4. 关联分析：在 `parse_report.js` 中将 App 异常、系统事件（Doze/Idle/网络状态）与 Ping 抖动/高延迟窗口做同窗对齐，识别“同时发生”关系并输出自动问题线索。
5. 可复盘输出：每次采集生成独立目录，包含 `report.md`、`analysis_meta.json`、`timeline.csv`、`ping_latency.csv` 等文件，便于横向对比不同设备/网络环境。
