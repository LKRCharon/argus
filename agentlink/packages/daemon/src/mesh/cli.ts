import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  MeshApprovalSchema,
  MeshCapabilityGrantSchema,
  MeshOperationSchema,
  MeshResourceListPayloadSchema,
  MeshTaskRequestSchema,
  type MeshScope,
  type MeshTaskRequest,
} from "@agentlink/wire";
import { fingerprint, b64decode } from "@agentlink/wire";
import { listPeers, loadOrCreateIdentity } from "../store";
import { joinChan, WsConn } from "../client";
import {
  createMeshServiceForPeer,
  loadMeshConfig,
  meshConfigPath,
} from "./config";
import { meshSigningPublicKeyBase64 } from "./signing";
import { MeshTaskStore } from "./task-store";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredFlag(argv: string[], flag: string): string {
  const value = flagValue(argv, flag)?.trim();
  if (!value) throw new Error(`缺少 ${flag}`);
  return value;
}

function parseScope(argv: string[]): MeshScope | undefined {
  const raw = flagValue(argv, "--scope-json");
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("--scope-json 必须是 JSON 对象");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--scope-json 必须是 JSON 对象");
  }
  return value as MeshScope;
}

function readJsonFile<T>(path: string, parse: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`无法读取 JSON 文件: ${path}`);
  }
  return parse(value);
}

function output(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value) + "\n");
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  }
}

export function runMeshStatus(args: string[]): void {
  const identity = loadOrCreateIdentity();
  const nodeId = fingerprint(identity.publicKey);
  const config = loadMeshConfig();
  const tasks = new MeshTaskStore().list(20).map((task) => ({
    taskId: task.taskId,
    groupId: task.groupId,
    resourceId: task.resourceId,
    operation: task.operation,
    status: task.status,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));
  const status = {
    type: "mesh-status",
    enabled: Boolean(config),
    configPath: meshConfigPath(),
    nodeId,
    signingPublicKey: config ? meshSigningPublicKeyBase64() : undefined,
    groups: config?.groups.map((group) => ({ id: group.id, members: group.members })) ?? [],
    resources: config?.resources.map((resource) => ({
      id: resource.id,
      ownerNodeId: resource.ownerNodeId,
      kind: resource.kind,
      displayName: resource.displayName,
    })) ?? [],
    runners: config?.runners?.map((runner) => ({
      id: runner.id,
      resourceId: runner.resourceId,
      maxRuntimeMs: runner.maxRuntimeMs,
      maxOutputBytes: runner.maxOutputBytes,
    })) ?? [],
    tasks,
    legacyControl: config?.legacyControl ?? false,
    remoteCodexControl: config?.remoteCodexControl ?? false,
    unattendedRuns: config?.unattendedRuns ? {
      groupIds: config.unattendedRuns.groupIds,
      requesterNodeIds: config.unattendedRuns.requesterNodeIds,
      resourceIds: config.unattendedRuns.resourceIds,
      runnerIds: config.unattendedRuns.runnerIds,
    } : undefined,
  };
  output(status, args.includes("--json"));
}

export async function runMeshResources(args: string[]): Promise<void> {
  const peers = Object.values(listPeers());
  if (peers.length === 0) throw new Error("尚未配对任何设备，请先运行 pair");
  const target = flagValue(args, "--target")?.trim();
  const peer = target
    ? peers.find((candidate) => candidate.fingerprint === target)
    : peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
  if (!peer) throw new Error(`未找到目标设备: ${target}`);

  const requestId = `resources_${randomUUID()}`;
  const conn = await WsConn.connect(process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws");
  try {
    const chan = await joinChan(conn, b64decode(peer.longTermKey));
    conn.send({
      op: "chan-data",
      data: { enc: await chan.seal({ kind: "mesh-resource-list-request", requestId }) },
    });
    for (;;) {
      const msg = await conn.wait((candidate) => candidate.op === "chan-data", 60_000);
      try {
        const payload = await chan.open<{ kind?: string; requestId?: string; code?: string; message?: string }>(msg.data?.enc);
        if (payload?.kind === "mesh-resource-list" && payload.requestId === requestId) {
          const parsed = MeshResourceListPayloadSchema.safeParse(payload);
          if (!parsed.success) {
            output({ kind: "mesh-error", code: "invalid-resource-list", message: "目标设备返回了无效的资源列表" }, args.includes("--json"));
          } else {
            output(parsed.data, args.includes("--json"));
          }
          return;
        }
        if (payload?.kind === "mesh-error") {
          output(payload, args.includes("--json"));
          return;
        }
      } catch {
        // Ignore unrelated or malformed channel payloads.
      }
    }
  } finally {
    conn.close();
  }
}

export function runMeshGrant(args: string[]): void {
  const config = loadMeshConfig();
  if (!config) throw new Error(`未找到 Mesh 配置: ${meshConfigPath()}`);
  const identity = loadOrCreateIdentity();
  const nodeId = fingerprint(identity.publicKey);
  const requesterNodeId = requiredFlag(args, "--requester");
  const task: MeshTaskRequest = MeshTaskRequestSchema.parse({
    groupId: requiredFlag(args, "--group"),
    taskId: flagValue(args, "--task")?.trim() || `task_${randomUUID()}`,
    requesterNodeId,
    targetNodeId: nodeId,
    resourceId: requiredFlag(args, "--resource"),
    operation: MeshOperationSchema.parse(requiredFlag(args, "--operation")),
    scope: parseScope(args),
  });
  const service = createMeshServiceForPeer(nodeId, requesterNodeId, config);
  const ttlRaw = flagValue(args, "--ttl-ms");
  const ttlMs = ttlRaw === undefined ? 15 * 60_000 : Number(ttlRaw);
  const grant = service.issueGrant(task, ttlMs);
  output(grant, args.includes("--json"));
}

export function runMeshApprove(args: string[]): void {
  const config = loadMeshConfig();
  if (!config) throw new Error(`未找到 Mesh 配置: ${meshConfigPath()}`);
  const grant = readJsonFile(requiredFlag(args, "--grant-file"), (value) => MeshCapabilityGrantSchema.parse(value));
  const identity = loadOrCreateIdentity();
  const nodeId = fingerprint(identity.publicKey);
  const service = createMeshServiceForPeer(nodeId, grant.subjectNodeId, config);
  const approval = service.issueApproval(grant, flagValue(args, "--summary") ?? "本地资源所有者批准精确 Mesh 任务");
  output(approval, args.includes("--json"));
}

export async function runMeshRequest(args: string[]): Promise<void> {
  const identity = loadOrCreateIdentity();
  const requesterNodeId = fingerprint(identity.publicKey);
  const peers = Object.values(listPeers());
  if (peers.length === 0) throw new Error("尚未配对任何设备，请先运行 pair");
  const target = flagValue(args, "--target")?.trim();
  const peer = target
    ? peers.find((candidate) => candidate.fingerprint === target)
    : peers.sort((a, b) => b.pairedAt - a.pairedAt)[0];
  if (!peer) throw new Error(`未找到目标设备: ${target}`);

  const grant = flagValue(args, "--grant-file")
    ? readJsonFile(requiredFlag(args, "--grant-file"), (value) => MeshCapabilityGrantSchema.parse(value))
    : undefined;
  const approval = flagValue(args, "--approval-file")
    ? readJsonFile(requiredFlag(args, "--approval-file"), (value) => MeshApprovalSchema.parse(value))
    : undefined;
  if (approval && !grant) throw new Error("--approval-file 必须和 --grant-file 一起使用");

  const task: MeshTaskRequest = MeshTaskRequestSchema.parse(grant ? {
    groupId: grant.groupId,
    taskId: grant.taskId,
    requesterNodeId,
    targetNodeId: peer.fingerprint,
    resourceId: grant.resourceId,
    operation: grant.operation,
    scope: Object.keys(grant.scope).length > 0 ? grant.scope : undefined,
  } : {
    groupId: requiredFlag(args, "--group"),
    taskId: flagValue(args, "--task")?.trim() || `task_${randomUUID()}`,
    requesterNodeId,
    targetNodeId: peer.fingerprint,
    resourceId: requiredFlag(args, "--resource"),
    operation: MeshOperationSchema.parse(requiredFlag(args, "--operation")),
    scope: parseScope(args),
  });
  if (grant && (grant.subjectNodeId !== requesterNodeId || grant.targetNodeId !== peer.fingerprint)) {
    throw new Error("grant 与本机请求者或目标设备不匹配");
  }

  const conn = await WsConn.connect(process.env.AGENTLINK_RELAY ?? "ws://127.0.0.1:8787/ws");
  try {
    const chan = await joinChan(conn, b64decode(peer.longTermKey));
    conn.send({
      op: "chan-data",
      data: {
        enc: await chan.seal({
          kind: "mesh-task-request",
          task,
          ...(grant ? { grant } : {}),
          ...(approval ? { approval } : {}),
        }),
      },
    });
    for (;;) {
      const msg = await conn.wait((candidate) => candidate.op === "chan-data", 60_000);
      try {
        const payload = await chan.open<{ kind?: string; taskId?: string }>(msg.data?.enc);
        if (payload?.kind === "mesh-task-result" && payload.taskId === task.taskId) {
          output(payload, args.includes("--json"));
          return;
        }
        if (payload?.kind === "mesh-error") {
          output(payload, args.includes("--json"));
          return;
        }
      } catch {
        // Ignore unrelated or malformed channel payloads.
      }
    }
  } finally {
    conn.close();
  }
}
