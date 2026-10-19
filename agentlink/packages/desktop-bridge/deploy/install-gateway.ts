import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

if (process.platform !== "linux") throw new Error("Run on the trusted Linux gateway");
const root = process.env.ARGUS_GATEWAY_HOME ?? join(homedir(), "argus-desktop-gateway");
const configFile = join(root, "config.json");
if (!existsSync(configFile)) throw new Error("Create a private config.json using the documented schema first");
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (!existsSync(config.authFile)) throw new Error("OJ verifier must already exist and be readable; it is never copied or changed");
const source = resolve(import.meta.dir, ".."), release = join(root, "releases", new Date().toISOString().replaceAll(/[:.]/g, "-") + "-" + crypto.randomUUID().slice(0, 6));
const target = join(release, "packages/desktop-bridge");
mkdirSync(join(target, "src"), { recursive: true, mode: 0o700 });
const hash = createHash("sha256");
for (const name of ["gateway.ts", "gateway-auth.ts", "security.ts"]) {
  const content = readFileSync(join(source, "src", name));
  cpSync(join(source, "src", name), join(target, "src", name)); hash.update(name + "\0").update(content);
}
if (!existsSync(join(source, "gateway-web/login.js"))) throw new Error("Build the gateway login assets first");
cpSync(join(source, "gateway-web"), join(target, "gateway-web"), { recursive: true });
const revision = process.argv.find(argument => argument.startsWith("--revision="))?.slice(11) ?? null;
if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid revision");
writeFileSync(join(release, "release.json"), JSON.stringify({ commit: revision, sourceSha256: hash.digest("hex"), installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const current = join(root, "current"), next = current + ".next";
for (const path of [current, next]) if (existsSync(path) && !lstatSync(path).isSymbolicLink()) throw new Error("Refusing an unmanaged installation path");
if (existsSync(next)) unlinkSync(next);
symlinkSync(release, next); renameSync(next, current);
console.log("Gateway release installed. Restart only argus-desktop-gateway.service after validation.");
