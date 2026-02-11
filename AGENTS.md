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

## AI 命令：评估最近一次日志/事件/报告（网络抖动原因）

当用户输入以下任一提示词时，视为调用该命令：

- `评估最近一次日志`
- `分析最近一次报告`
- `检查最新网络抖动原因`
- `执行：最近一次抖动归因评估`

执行规则（强制）：

1. 自动定位 `logs/` 下最新时间戳目录（如 `logs/20260211_163149`）作为分析对象；若用户明确指定目录，则以用户指定为准。
2. 优先读取并交叉验证以下文件（按优先级）：`report.md`、`analysis_meta.json`、`timeline.csv`、`ping_latency.csv`、`app_metrics.csv`、`app_focus.log`、`logcat_all.log`。
3. 若 `report.md` 或 `analysis_meta.json` 缺失，先执行 `npm run report`（该脚本默认分析最新目录）补齐产物后再评估。
4. 归因时必须做时间同窗关联：至少检查 `Ping 高延迟/丢包` 与 `Doze/Idle`、`Wi-Fi/Connectivity 状态切换`、`Moonlight/LimeLog 异常` 在 ±60 秒窗口内是否共现。
5. 输出必须包含“可疑原因排序”，且每项必须给出：`原因`、`证据文件`、`关键时间点`、`置信度（高/中/低）`、`验证建议`。
6. 证据不足时不得臆断，必须明确“缺失数据项 + 下一次采集建议”（优先建议 `npm run capture:ping`）。
7. 输出语言固定中文；禁止只给结论不附证据。

建议输出结构（固定）：

1. `分析目标`：最新目录路径、采集时间范围。
2. `结论摘要`：一句话概括是否存在明显抖动诱因。
3. `可疑原因 TOP 3`：按置信度排序列出证据。
4. `关键时间线`：列出“抖动点 <-> 系统/应用事件”对应关系。
5. `下一步动作`：最小化复现与补采集建议。
