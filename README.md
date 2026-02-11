# iqoo-deubg

一个面向 **Android 非 root** 场景的串流诊断工具，用于定位 Moonlight/Sunshine 链路中的周期性抖动、瞬时高延迟和卡顿成因。

## 项目目的

本项目聚焦“可复盘”的网络抖动排查，核心是把 App 日志、系统状态和网络时延放到同一时间线上做联合分析：

- 统一采集：同时抓取 `logcat` 与多类 `dumpsys`（wifi/connectivity/deviceidle/power/alarm/jobscheduler）。
- 连续延迟采样：支持手机侧 `adb shell ping` 与 Windows 11 主机侧协同 `nping` 同启同停。
- 双端时间对齐：手机侧和主机侧 ping 原始日志统一逐行写入 `+08:00` 与 `epoch_ms`。
- App 专项分析：从 `logcat_all.log` 抽取 Moonlight/LimeLog 指标与异常，生成 `app_focus.log`、`app_metrics.csv`、`internal_stats.csv`。
- 关联归因：自动对齐 Ping 抖动/高延迟、系统状态切换和 App 异常，输出原因排序与证据。

## 环境要求

- Node.js `>=20`
- 已安装 Android Platform Tools（`adb` 在 PATH）
- Android 手机已开启 USB 调试并授权
- 若启用主机侧协同 ping，目标主机必须是 Windows 11 且已部署 OpenSSH + Nmap/nping

安装依赖：

```bash
npm install
```

## 快速开始

1. 配置 `capture.config.json`：

```json
{
  "pingLogTzOffset": "+08:00",
  "hostPing": {
    "enabled": false,
    "hostIp": "192.168.5.25",
    "intervalSec": 0.2
  },
  "hostSidePing": {
    "enabled": false,
    "hostIp": "192.168.5.23",
    "intervalSec": 0.2,
    "sshHost": "192.168.5.25",
    "sshPort": 22,
    "sshUser": "iqoo_ping",
    "sshKeyPath": "~/.ssh/id_rsa",
    "remoteScriptDir": "C:\\iqoo-ping"
  }
}
```

2. 执行采集：

```bash
# 仅基础采集
npm run capture

# 手机侧 ping 协同采集
npm run capture:ping
```

3. 执行双端协同（手机 + Windows 主机）：

```bash
node capture.js \
  --minutes 15 \
  --host-ping \
  --host-ip 192.168.5.25 \
  --ping-interval 0.2 \
  --host-side-ping \
  --host-side-ip 192.168.5.88 \
  --host-side-interval 0.2 \
  --host-side-ssh-host 192.168.5.25 \
  --host-side-ssh-port 22 \
  --host-side-ssh-user iqoo_ping \
  --host-side-ssh-key ~/.ssh/id_rsa \
  --ping-log-tz-offset +08:00
```

4. 报告解析：

```bash
# 解析最新一次采集目录
npm run report

# 解析指定目录
node parse_report.js --dir ./logs/20260211_163149
```

## 关键参数

- `--host-ping`：启用手机侧 `adb shell ping`
- `--host-ip`：手机侧 ping 目标 IP（Sunshine 主机或路由器 LAN IP）
- `--ping-interval`：手机侧 ping 间隔（秒）
- `--host-side-ping`：启用 Windows 11 主机侧协同 ping
- `--host-side-ip`：主机侧 ping 目标 IP（通常为手机 Wi-Fi IP）
- `--host-side-interval`：主机侧 ping 间隔（秒）
- `--host-side-ssh-host`：Windows 主机 SSH 地址
- `--host-side-ssh-port`：Windows 主机 SSH 端口
- `--host-side-ssh-user`：Windows 主机 SSH 用户
- `--host-side-ssh-key`：SSH 私钥路径
- `--ping-log-tz-offset`：ping 日志时区偏移（默认 `+08:00`）

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
  ping_host.log
  ping_host_side.log
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
  ping_latency_host_side.csv
  ping_latency_host_side_session.csv
```

排障时优先看：

- `report.md`
- `analysis_meta.json`
- `ping_latency.csv` 与 `ping_latency_host_side.csv`
- `timeline.csv`
- `app_metrics.csv` 与 `internal_stats.csv`

## 双端日志时间格式（强制）

手机侧 `ping_host.log` 与主机侧 `ping_host_side.log` 都按统一格式逐行写入：

```text
[ts_local=YYYY-MM-DD HH:mm:ss.SSS +08:00][epoch_ms=1739271685123][source=device_side_ping|host_side_ping] <raw line>
```

## Windows 11 主机部署章节（固化版）

### 1) 部署目标

- 允许采集机通过 SSH 远程启动/停止主机侧高频 ping。
- 主机日志可直接用于同窗对齐分析（`+08:00` + `epoch_ms`）。

### 2) 一次性安装与系统配置

管理员 PowerShell 执行：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
winget install -e --id Insecure.Nmap
nping --version
```

### 3) 账号与安全基线

- 创建专用低权限账号（示例：`iqoo_ping`），不要使用管理员账号。
- 启用 SSH 公钥登录并禁用密码登录。
- 将采集机公钥写入 `C:\Users\iqoo_ping\.ssh\authorized_keys`。
- 将防火墙规则收敛为仅允许采集机 IP。
- `sshd_config` 最低要求：
  - `PubkeyAuthentication yes`
  - `PasswordAuthentication no`
  - `AllowUsers iqoo_ping`
- 修改后重启服务：

```powershell
Restart-Service sshd
```

### 4) 主机脚本部署规范

- 目录固定：`C:\iqoo-ping\`
- 脚本固定：
  - `start_host_ping.ps1`
  - `stop_host_ping.ps1`
  - `status_host_ping.ps1`
- 本仓库脚本路径：`scripts/windows/*.ps1`
- 复制到主机目录（在 Windows 主机执行）：

```powershell
New-Item -ItemType Directory -Path C:\iqoo-ping -Force
Copy-Item .\scripts\windows\*.ps1 C:\iqoo-ping\ -Force
```

`start_host_ping.ps1` 入参：`TargetIp`、`IntervalMs`、`LogFile`、`PidFile`、`TzOffset`  
`stop_host_ping.ps1` 行为：按 PID 优雅停止，超时后强制停止  
`status_host_ping.ps1` 行为：返回 running/stopped 与 PID

### 5) 主机日志格式（强制）

每行格式：

```text
[ts_local=YYYY-MM-DD HH:mm:ss.SSS +08:00][epoch_ms=1739271685123][source=host_side_ping] <raw nping line>
```

- 每行必须带 `ts_local` 与 `epoch_ms`。
- 主机脚本内部强制按 `China Standard Time` 输出 `+08:00`。

### 6) Windows 侧验收清单

- 采集机可 SSH 登录：`ssh -i <key> iqoo_ping@<win_host>`
- 远程执行 `nping --version` 成功
- 远程启动脚本后 `ping_host_side.log` 持续增长
- 远程停止脚本后主机 ping 进程退出，PID 文件清理
- 日志抽样 20 行，全部具备 `+08:00` 与 `epoch_ms`

### 7) 回滚方案

- 停止并禁用 `sshd` 服务
- 删除防火墙规则
- 删除 `C:\iqoo-ping\` 与专用账号
- 恢复为仅手机侧 ping 模式（不传 `--host-side-ping`）

## 报告能力（双向归因）

报告新增以下内容：

- 主机侧 ping CSV：`ping_latency_host_side.csv`、`ping_latency_host_side_session.csv`
- 主机侧协同 Ping 章节（会话内统计）
- 双向链路判定（`bidirectional` / `device_uplink_dominant` / `host_downlink_dominant` 等）

兼容性：旧目录即使只有 `ping_host.log`，`npm run report` 仍可成功。

## 失败策略

- 当 `--host-side-ping` 启用但 SSH/PowerShell/nping/脚本不可用时，采集会 **fail-fast** 并明确报错，不做静默降级。

## AI 快捷评估口令

在本仓库中可直接对 AI 说以下任一句，触发“最新一次抖动归因评估”流程：

- `评估最近一次日志`
- `分析最近一次报告`
- `检查最新网络抖动原因`
- `执行：最近一次抖动归因评估`
