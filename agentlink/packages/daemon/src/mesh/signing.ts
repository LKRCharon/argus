/**
 * Persistent owner signing identity for Mesh grants and approvals.
 *
 * This key is intentionally separate from the X25519 pairing identity. The
 * pairing key establishes transport trust; this Ed25519 key represents the
 * resource owner's authorization authority and can be rotated independently.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { b64decode, b64encode, generateMeshSigningKeyPair, type MeshSigningKeyPair } from "@agentlink/wire";
import { configDir } from "../store";
import { join } from "node:path";

const FILE_VERSION = 1;

function signingFile(): string {
  return join(configDir(), "mesh-signing.json");
}

function decodeKey(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Mesh signing ${label} 缺失`);
  let decoded: Uint8Array;
  try {
    decoded = b64decode(value);
  } catch {
    throw new Error(`Mesh signing ${label} 格式错误`);
  }
  if (decoded.length !== 32) throw new Error(`Mesh signing ${label} 长度错误`);
  return decoded;
}

export function loadOrCreateMeshSigningKey(): MeshSigningKeyPair {
  const file = signingFile();
  if (existsSync(file)) {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
      throw new Error("Mesh signing identity 权限过宽，请设置为 0600");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error("Mesh signing identity 无法读取；为避免换身份后误信旧授权，已停止启动");
    }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== FILE_VERSION) {
      throw new Error("Mesh signing identity 版本不支持");
    }
    const record = value as { secretKey?: unknown; publicKey?: unknown };
    return {
      secretKey: decodeKey(record.secretKey, "secretKey"),
      publicKey: decodeKey(record.publicKey, "publicKey"),
    };
  }

  const key = generateMeshSigningKeyPair();
  writeFileSync(
    file,
    JSON.stringify({
      version: FILE_VERSION,
      secretKey: b64encode(key.secretKey),
      publicKey: b64encode(key.publicKey),
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  chmodSync(file, 0o600);
  return key;
}

export function meshSigningPublicKeyBase64(): string {
  return b64encode(loadOrCreateMeshSigningKey().publicKey);
}
