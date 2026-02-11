# iqoo-deubg

一个面向 **Android 非 root** 场景的串流诊断工具，用于定位 Moonlight/Sunshine 链路中的周期性抖动、瞬时高延迟和卡顿成因。

## 项目目的

本项目聚焦“可复盘”的网络抖动排查，核心是把 App 日志、系统状态和网络时延放到同一时间线上做联合分析：

- 统一采集：同时抓取 `logcat` 与多类 `dumpsys`（wifi/connectivity/deviceidle/power/alarm/jobscheduler）。
- 连续延迟采样：可选开启手机侧 `adb shell ping`，记录 `ping_host.log`，用于秒级抖动定位。
- App 专项分析：从 `logcat_all.log` 抽取 Moonlight/LimeLog 指标与异常，生成 `app_focus.log`、`app_metrics.csv`、`internal_stats.csv`。
- 关联归因：自动对齐 Ping 抖动/高延迟、系统状态切换和 App 异常，输出原因排序与证据。
- 独立批次产物：每次采集生成时间戳目录，便于横向对比不同网络环境和设置。

## 环境要求

- Node.js `>=20`
- 已安装 Android Platform Tools（`adb` 在 PATH）
- Android 手机已开启 USB 调试并授权

安装依赖：

```bash
npm install
```

## 快速开始（推荐流程）

1. 配置 `capture.config.json`（建议先填好主机 IP）：

```json
{
  "hostPing": {
    "enabled": false,
    "hostIp": "192.168.5.25",
    "intervalSec": 0.2
  }
}
```

2. 执行采集（推荐带 ping）：

```bash
npm run capture:ping
```

3. 采集结束后会自动触发报告解析；你也可以手动重跑最新目录：

```bash
npm run report
```

## 常用命令

### 采集

- 默认采集（30 分钟）：`npm run capture`
- 采集并启用 host ping：`npm run capture:ping`
- 自定义参数：

```bash
node capture.js \
  --minutes 20 \
  --out ./logs \
  --host-ping \
  --host-ip 192.168.5.25 \
  --ping-interval 0.2
```

关键参数：

- `--minutes`：采集时长（分钟）
- `--out`：输出根目录（默认 `./logs`）
- `--config`：配置文件路径（默认 `./capture.config.json`）
- `--host-ping`：启用 `adb shell ping`
- `--host-ip`：被 ping 的主机 IP（Sunshine 主机或路由器 LAN IP）
- `--ping-interval`：ping 间隔（秒）

### 报告解析

```bash
# 解析最新一次采集目录
npm run report

# 解析指定目录
node parse_report.js --dir ./logs/20260211_163149
```

可选高级参数（按需）：

- `--stream-window-mode auto|strict|all`
- `--noise-policy balanced|aggressive|conservative`
- `--session-pre-buffer-sec`
- `--session-post-buffer-sec`
- `--clock-skew-tolerance-sec`
- `--no-valid-session-policy empty-main|degraded`

## 输出目录与关键文件

每次采集都会生成 `logs/<时间戳>/`，典型结构如下：

```text
logs/20260211_163149/
  capture_meta.json
  logcat_all.log
  logcat_stderr.log
  dumpsys_wifi.log
  dumpsys_conn.log
  dumpsys_deviceidle.log
  dumpsys_power.log
  dumpsys_alarm.log
  dumpsys_jobs.log
  ping_host.log                  # 启用 host ping 时存在
  report.md
  analysis_meta.json
  timeline.csv
  timeline_session.csv
  intervals.csv
  intervals_session.csv
  stream_windows.csv
  stream_windows_effective.csv
  app_focus.log
  app_metrics.csv
  internal_stats.csv
  ping_latency.csv
  ping_latency_session.csv
```

排障时优先看：

- `report.md`：总览结论与原因排序
- `analysis_meta.json`：结构化分析结果（便于脚本二次处理）
- `ping_latency.csv`：延迟/抖动样本明细
- `timeline.csv`：系统事件时间线（分钟粒度）
- `app_metrics.csv` 与 `internal_stats.csv`：Moonlight/LimeLog 指标

## 抖动归因方法（简版）

报告会围绕串流有效窗口做“同窗关联”，核心检查：

- Ping 高延迟/抖动点
- Doze/Idle、Wi-Fi/Connectivity 切换事件
- Moonlight/LimeLog 异常与性能指标

并输出可疑原因排序（例如：网络路径抖动、RTT 方差突发、解码渲染过载、系统状态切换干扰）。

## 建议采集规范

- 采集时尽量完整覆盖“开始串流 -> 发生卡顿 -> 恢复/结束”全过程（建议 >= 10 分钟）。
- 优先使用 `npm run capture:ping`，否则网络层证据会明显不足。
- 尽量避免采集中频繁切前后台，减少会话识别缺失。
- 若设备允许，开启 Wi-Fi verbose logging。

## AI 快捷评估口令

在本仓库中可直接对 AI 说以下任一句，触发“最新一次抖动归因评估”流程：

- `评估最近一次日志`
- `分析最近一次报告`
- `检查最新网络抖动原因`
- `执行：最近一次抖动归因评估`

该流程会自动定位 `logs/` 最新目录，必要时补跑 `npm run report`，并给出基于证据的可疑原因排序和下一步采集建议。
