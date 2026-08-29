import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  MeshGroupIdSchema,
  MeshIdSchema,
  MeshJsonValueSchema,
  MeshNodeIdSchema,
  MeshResourceIdSchema,
  MeshResourceKindSchema,
  MeshRunnerIdSchema,
  MeshWorkspaceCapabilitySchema,
} from "@agentlink/wire";
import { configDir } from "../store";
import { MeshService, type MeshServiceOptions } from "./service";
import { type MeshRunnerSpec } from "./runner";

const MeshConfigSchema = z.object({
  version: z.literal(1),
  groups: z.array(z.object({
    id: MeshGroupIdSchema,
    members: z.array(MeshNodeIdSchema).min(1),
  })).min(1),
  requesters: z.array(MeshNodeIdSchema).optional(),
  unattendedRuns: z.object({
    groupIds: z.array(MeshGroupIdSchema).min(1).max(64),
    requesterNodeIds: z.array(MeshNodeIdSchema).min(1).max(64),
    resourceIds: z.array(MeshResourceIdSchema).min(1).max(64),
    runnerIds: z.array(MeshRunnerIdSchema).min(1).max(64),
  }).strict().optional(),
  legacyControl: z.boolean().default(false),
  remoteCodexControl: z.boolean().default(false),
  allowedRoots: z.array(z.string().refine(isAbsolute, "allowedRoots must be absolute")).optional(),
  quarantineRoot: z.string().refine(isAbsolute, "quarantineRoot must be absolute").optional(),
  artifactRoot: z.string().refine(isAbsolute, "artifactRoot must be absolute").optional(),
  resources: z.array(z.object({
    id: MeshResourceIdSchema,
    ownerNodeId: MeshNodeIdSchema,
    kind: MeshResourceKindSchema,
    displayName: MeshIdSchema,
    root: z.string().refine(isAbsolute, "resource root must be absolute"),
    statusRunnerId: MeshRunnerIdSchema.optional(),
    allowedGroupIds: z.array(MeshGroupIdSchema).max(32).optional(),
  })),
  runners: z.array(z.object({
    id: MeshRunnerIdSchema,
    resourceId: MeshResourceIdSchema,
    purpose: z.enum(["task", "status"]).default("task"),
    executable: z.string().refine(isAbsolute, "runner executable must be absolute"),
    fixedArgs: z.array(z.string().max(4096)).max(32).optional(),
    workdir: z.string().optional(),
    env: z.record(z.string(), z.string().max(4096)).optional(),
    maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
    maxOutputBytes: z.number().int().min(1_024).max(1 * 1024 * 1024).optional(),
    allowDynamicArgs: z.boolean().default(false),
    allowInput: z.boolean().default(false),
    title: z.string().min(1).max(128).optional(),
    inputSchema: MeshJsonValueSchema.optional(),
    resultSchema: MeshJsonValueSchema.optional(),
    approvalRequired: z.boolean().optional(),
    workspaceCapabilities: z.array(MeshWorkspaceCapabilitySchema).max(8).optional(),
    exposeDebugOutput: z.boolean().optional(),
    /** Backward-compatible local name; never published to peers. */
    exposeOutput: z.boolean().optional(),
  })).optional(),
}).strict();

export type MeshConfig = z.infer<typeof MeshConfigSchema>;

export function parseMeshConfig(value: unknown): MeshConfig {
  const parsed = MeshConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error("Mesh 配置格式无效");
  return parsed.data;
}

export function meshConfigPath(): string {
  return process.env.AGENTLINK_MESH_CONFIG?.trim() || join(configDir(), "mesh.json");
}

export function loadMeshConfig(): MeshConfig | undefined {
  const file = meshConfigPath();
  if (!existsSync(file)) return undefined;
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error("Mesh 配置文件权限过宽，请设置为 0600");
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return parseMeshConfig(raw);
}

export function createMeshServiceForPeer(nodeId: string, peerNodeId: string, config: MeshConfig): MeshService {
  const options: MeshServiceOptions = {
    nodeId,
    trustedGroups: new Set(config.groups.map((group) => group.id)),
    groupMembers: new Map(config.groups.map((group) => [group.id, new Set(group.members)])),
    // The requester carried in a task must be the authenticated transport
    // peer. A configured allowlist may deny that peer, but can never let it
    // claim another allowlisted identity.
    trustedRequesters: trustedMeshRequestersForPeer(peerNodeId, config.requesters),
    allowedRoots: config.allowedRoots,
    quarantineRoot: config.quarantineRoot ?? join(homedir(), ".agentlink", "quarantine"),
    artifactRoot: config.artifactRoot ?? join(homedir(), ".agentlink", "mesh-workspaces"),
    resources: config.resources,
    runners: config.runners as MeshRunnerSpec[] | undefined,
    unattendedRuns: config.unattendedRuns ? {
      groupIds: new Set(config.unattendedRuns.groupIds),
      requesterNodeIds: new Set(config.unattendedRuns.requesterNodeIds),
      resourceIds: new Set(config.unattendedRuns.resourceIds),
      runnerIds: new Set(config.unattendedRuns.runnerIds),
    } : undefined,
  };
  return new MeshService(options);
}

export function trustedMeshRequestersForPeer(
  peerNodeId: string,
  configuredRequesters?: readonly string[],
): ReadonlySet<string> {
  return new Set(configuredRequesters === undefined || configuredRequesters.includes(peerNodeId)
    ? [peerNodeId]
    : []);
}

export function loadMeshServiceForPeer(nodeId: string, peerNodeId: string): MeshService | undefined {
  const config = loadMeshConfig();
  return config ? createMeshServiceForPeer(nodeId, peerNodeId, config) : undefined;
}
