import { execa } from 'execa';

export async function runAdb(args, opts = {}) {
  return execa('adb', args, {
    windowsHide: true,
    ...opts
  });
}

export function adbArgsForSerial(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

export function parseDevices(output) {
  const lines = output.split(/\r?\n/).slice(1).map((x) => x.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(/\s+/);
    return {
      serial: parts[0] || '',
      state: parts[1] || '',
      raw: line
    };
  });
}
