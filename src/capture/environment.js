import { runAdb, parseDevices } from '../shared/adb.js';

export async function ensureAdbAndPickDevice() {
  console.log('[capture] 开始环境检查...');
  try {
    const ver = await runAdb(['version']);
    console.log(ver.stdout.trim());
  } catch (err) {
    if (process.platform === 'win32') {
      throw new Error(`无法执行 adb version。请确认 Android Platform Tools 已安装且 adb.exe 在 PATH。${String(err.message || err)}`);
    }
    throw new Error(`无法执行 adb version，请先安装 Android Platform Tools。${String(err.message || err)}`);
  }

  let devicesInfo;
  try {
    devicesInfo = await runAdb(['devices', '-l']);
  } catch (err) {
    throw new Error(`adb devices -l 执行失败: ${String(err.message || err)}`);
  }
  console.log(devicesInfo.stdout.trim());

  const devices = parseDevices(devicesInfo.stdout);
  const okDevices = devices.filter((d) => d.state === 'device');
  const unauthorized = devices.filter((d) => d.state === 'unauthorized');
  const offline = devices.filter((d) => d.state === 'offline');

  if (okDevices.length === 0) {
    if (unauthorized.length > 0) {
      throw new Error('检测到 unauthorized 设备。请在手机上允许 USB 调试（建议勾选“始终允许”）后重试。');
    }
    if (offline.length > 0) {
      throw new Error('检测到 offline 设备。请重插数据线，或执行 adb kill-server && adb start-server 后重试。');
    }
    throw new Error('未检测到可用设备。请确认 USB 调试已开启并已连接。');
  }

  if (okDevices.length > 1) {
    console.warn(`[capture] 检测到多个 device，默认使用第一个: ${okDevices[0].serial}`);
  }

  console.log('[capture] 提示：请在开发者选项中开启 Wi-Fi verbose logging（Wi-Fi 详细日志）。');
  console.log('[capture] 提示：长时间抓取建议开启“保持唤醒/屏幕常亮”（可选）。');
  return {
    serial: okDevices[0].serial,
    devices
  };
}
