import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configDir } from "../store";
import {
  DelegationConfigSchema,
  isWithin,
  type DelegationConfig,
} from "./schemas";
import { atomicWritePrivateJson, readPrivateJson } from "./private-json";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export function delegationConfigPath(): string {
  return process.env.AGENTLINK_DELEGATION_CONFIG?.trim()
    || join(configDir(), "delegation", "config.json");
}

/** Owner-managed project and principal policy stored outside delegated roots. */
export class DelegationConfigStore {
  constructor(private readonly file = delegationConfigPath()) {}

  load(): DelegationConfig | undefined {
    if (!existsSync(this.file)) return undefined;
    const raw = readPrivateJson(this.file, "delegation config", MAX_CONFIG_BYTES);
    const parsed = DelegationConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error("delegation config schema is invalid");
    assertConfigOutsideProjectRoots(this.file, parsed.data);
    return structuredClone(parsed.data);
  }

  save(config: DelegationConfig): DelegationConfig {
    const parsed = DelegationConfigSchema.parse(config);
    assertConfigOutsideProjectRoots(this.file, parsed);
    atomicWritePrivateJson(this.file, parsed, "delegation config", MAX_CONFIG_BYTES);
    return structuredClone(parsed);
  }
}

export function assertConfigOutsideProjectRoots(file: string, config: DelegationConfig): void {
  const configCandidates = pathCandidates(file);
  for (const project of config.projects) {
    for (const root of [project.sourceRoot, project.workRoot]) {
      const rootCandidates = pathCandidates(root);
      if (configCandidates.some((candidate) => rootCandidates.some((projectRoot) => isWithin(projectRoot, candidate)))) {
        throw new Error(`delegation config must be outside project roots (${project.id})`);
      }
    }
  }
}

function pathCandidates(path: string): string[] {
  const lexical = resolve(path);
  const canonical = canonicalizePotentialPath(lexical);
  return lexical === canonical ? [lexical] : [lexical, canonical];
}

function canonicalizePotentialPath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    missing.push(basename(cursor));
    cursor = parent;
  }
  let canonical = realpathSync(cursor);
  for (const segment of missing.reverse()) canonical = join(canonical, segment);
  return resolve(canonical);
}
