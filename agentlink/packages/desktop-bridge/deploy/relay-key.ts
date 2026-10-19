import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path || path.startsWith("--")) throw new Error("Usage: bun run relay-key.ts public-key-file [--with-viewer]");
const lines = readFileSync(path,"utf8").trim().split(/\r?\n/);
if (lines.length !== 1) throw new Error("Expected exactly one public key");
const [type, key] = lines[0].trim().split(/\s+/);
if (type !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+=*$/.test(key ?? "")) throw new Error("Expected an Ed25519 public key");
const listeners = [18943, ...(process.argv.includes("--with-viewer") ? [18942] : [])].map(port => `permitlisten="127.0.0.1:${port}"`).join(",");
console.log(`restrict,port-forwarding,command="/usr/bin/false",${listeners},permitopen="127.0.0.1:1" ${type} ${key} argus-desktop-web`);
