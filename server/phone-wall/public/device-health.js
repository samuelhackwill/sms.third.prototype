export function powerReading(device, now = Date.now()) {
  const telemetry = device?.telemetry ?? {};
  const battery = Number.isFinite(telemetry.battery) && telemetry.battery >= 0 && telemetry.battery <= 1 ? `${Math.round(telemetry.battery * 100)}%` : '-';
  const source = typeof telemetry.charging === 'boolean' ? telemetry.charging ? 'Plugged' : 'Unplugged' : 'No data';
  // A new socket/hello is not a new battery measurement.
  const stale = !!device && (!device.connected || !Number.isFinite(device.telemetryAt) || now - device.telemetryAt > 30000);
  return { battery, source, stale, state: source === 'Plugged' ? 'plugged' : source === 'Unplugged' ? 'unplugged' : 'unknown' };
}
