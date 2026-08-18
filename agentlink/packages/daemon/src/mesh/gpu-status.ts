import {
  MeshResourceStatusSchema,
  type MeshGpuDeviceStatus,
  type MeshResourceStatus,
} from "@agentlink/wire";

const UNKNOWN_VALUES = new Set(["", "N/A", "NA", "Not Supported", "-", "[N/A]"]);

/**
 * Parse the owner-configured nvidia-smi CSV probe into a bounded wire status.
 * The raw command output never crosses the channel.
 */
export function parseGpuStatus(stdout: string, observedAt = new Date().toISOString()): MeshResourceStatus {
  const devices = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseDevice(line, index))
    .filter((device): device is MeshGpuDeviceStatus => device !== undefined)
    .slice(0, 64);

  const totalMemory = sum(devices.map((device) => device.memoryTotalMiB));
  const usedMemory = sum(devices.map((device) => device.memoryUsedMiB));
  const utilization = average(devices.map((device) => device.utilizationGpuPercent));
  const summary = devices.length === 0
    ? "未发现 GPU"
    : `${devices.length} 个 GPU · ${formatPercent(utilization)} · ${formatMiB(usedMemory)}/${formatMiB(totalMemory)} MiB`;

  return MeshResourceStatusSchema.parse({
    state: devices.length > 0 ? "ready" : "degraded",
    summary,
    observedAt,
    gpu: { devices },
  });
}

export function failedGpuStatus(message: string, observedAt = new Date().toISOString()): MeshResourceStatus {
  return MeshResourceStatusSchema.parse({
    state: "error",
    summary: "GPU 状态读取失败",
    observedAt,
    error: message.replace(/\/[^\s,;]+/g, "<local-path>").slice(0, 512),
    gpu: { devices: [] },
  });
}

function parseDevice(line: string, fallbackIndex: number): MeshGpuDeviceStatus | undefined {
  const fields = line.split(",").map((field) => field.trim());
  // Current probe: index,name,temperature,memory.used,memory.total,utilization,driver.
  // The three-column fallback keeps a previously deployed L40 probe readable
  // during a rolling config update.
  if (fields.length >= 7) {
    const index = parseInteger(fields[0]);
    const name = fields[1] || "GPU";
    return {
      index: index ?? fallbackIndex,
      name: name.slice(0, 128),
      temperatureC: parseNumber(fields[2]),
      memoryUsedMiB: parseNumber(fields[3]),
      memoryTotalMiB: parseNumber(fields[4]),
      utilizationGpuPercent: parseNumber(fields[5]),
      driverVersion: normalizeText(fields[6]),
    };
  }
  if (fields.length >= 3) {
    return {
      index: fallbackIndex,
      name: (fields[0] || "GPU").slice(0, 128),
      temperatureC: null,
      memoryUsedMiB: null,
      memoryTotalMiB: parseNumber(fields[1]),
      utilizationGpuPercent: null,
      driverVersion: normalizeText(fields[2]),
    };
  }
  return undefined;
}

function normalizeText(value: string): string | null {
  return UNKNOWN_VALUES.has(value) ? null : value.slice(0, 128);
}

function parseNumber(value: string): number | null {
  if (UNKNOWN_VALUES.has(value)) return null;
  const parsed = Number.parseFloat(value.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function average(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) / known.length : null;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatMiB(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}
