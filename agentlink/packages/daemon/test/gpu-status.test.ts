import { describe, expect, test } from "bun:test";
import { failedGpuStatus, parseGpuStatus } from "../src/mesh/gpu-status";

describe("GPU status probe", () => {
  test("parses bounded nvidia-smi CSV into device metrics", () => {
    const status = parseGpuStatus([
      "0, NVIDIA L40, 42, 1024, 46068, 12, 535.309.01",
      "1, NVIDIA L40, 44, 2048, 46068, 18, 535.309.01",
    ].join("\n"), "2026-08-18T00:00:00.000Z");

    expect(status).toMatchObject({
      state: "ready",
      summary: "2 个 GPU · 15% · 3072/92136 MiB",
      observedAt: "2026-08-18T00:00:00.000Z",
      gpu: {
        devices: [
          { index: 0, name: "NVIDIA L40", temperatureC: 42, utilizationGpuPercent: 12 },
          { index: 1, name: "NVIDIA L40", temperatureC: 44, utilizationGpuPercent: 18 },
        ],
      },
    });
  });

  test("keeps a previous three-column probe readable during config rollout", () => {
    const status = parseGpuStatus("NVIDIA L40, 46068 MiB, 535.309.01\n");
    expect(status).toMatchObject({
      state: "ready",
      gpu: { devices: [{ name: "NVIDIA L40", memoryTotalMiB: 46068, driverVersion: "535.309.01" }] },
    });
  });

  test("does not expose raw probe output on failure", () => {
    const status = failedGpuStatus("runner failed: /private/internal/path");
    expect(status).toMatchObject({ state: "error", summary: "GPU 状态读取失败" });
    expect(JSON.stringify(status)).not.toContain("/private/internal/path");
  });
});
