import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { MeshIdSchema, MeshResourceKindSchema } from "@agentlink/wire";
import { configDir } from "../store";
import { MeshService, type MeshServiceOptions } from "./service";

const MeshConfigSchema = z.object({
  version: z.literal(1),
  groups: z.array(z.object({
    id: MeshIdSchema,
    members: z.array(MeshIdSchema).min(1),
  })).min(1),
  requesters: z.array(MeshIdSchema).optional(),
  legacyControl: z.boolean().default(false),
  allowedRoots: z.array(z.string().refine(isAbsolute, "allowedRoots must be absolute")).optional(),
  quarantineRoot: z.string().refine(isAbsolute, "quarantineRoot must be absolute").optional(),
  resources: z.array(z.object({
    id: MeshIdSchema,
    ownerNodeId: MeshIdSchema,
    kind: MeshResourceKindSchema,
    displayName: MeshIdSchema,
    root: z.string().refine(isAbsolute, "resource root must be absolute"),
  })),
});

export type MeshConfig = z.infer<typeof MeshConfigSchema>;

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
  const parsed = MeshConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Mesh 配置格式无效");
  return parsed.data;
}

export function createMeshServiceForPeer(nodeId: string, peerNodeId: string, config: MeshConfig): MeshService {
  const options: MeshServiceOptions = {
    nodeId,
    trustedGroups: new Set(config.groups.map((group) => group.id)),
    groupMembers: new Map(config.groups.map((group) => [group.id, new Set(group.members)])),
    // Pairing establishes the transport peer; an explicit requester list can
    // further narrow it. Never accept an arbitrary requester from the task.
    trustedRequesters: new Set(config.requesters ?? [peerNodeId]),
    allowedRoots: config.allowedRoots,
    quarantineRoot: config.quarantineRoot ?? join(homedir(), ".agentlink", "quarantine"),
    resources: config.resources,
  };
  return new MeshService(options);
}

export function loadMeshServiceForPeer(nodeId: string, peerNodeId: string): MeshService | undefined {
  const config = loadMeshConfig();
  return config ? createMeshServiceForPeer(nodeId, peerNodeId, config) : undefined;
}
