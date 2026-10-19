import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("Build this optional window component on macOS");
const output = resolve(process.argv[2] ?? join(import.meta.dir, "build"));
if (existsSync(output)) throw new Error("Choose a fresh output directory; existing apps are never replaced");
const app = join(output, "ArgusAppView.app"), contents = join(app, "Contents");
mkdirSync(join(contents, "MacOS"), {recursive:true});
cpSync(join(import.meta.dir,"source","Info.plist"),join(contents,"Info.plist"));
mkdirSync(join(output,"web"));
for (const name of ["index.html","style.css","app.js"]) cpSync(join(import.meta.dir,"source",name),join(output,"web",name));
function run(command: string, args: string[]) {
  const result = spawnSync(command,args,{stdio:"inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
run("/usr/bin/xcrun",["swiftc","-O","-parse-as-library","-target",`${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.2`,join(import.meta.dir,"source","ArgusAppView.swift"),"-o",join(contents,"MacOS","ArgusAppView"),"-framework","AppKit","-framework","ApplicationServices","-framework","ScreenCaptureKit","-framework","Network","-framework","CoreImage","-framework","CoreMedia"]);
run("/usr/bin/codesign",["--sign","-","--timestamp=none",app]);
run("/usr/bin/codesign",["--verify","--strict",app]);
console.log(`Built ${app}\nWeb assets: ${join(output,"web")}\nNo installed component or macOS authorization was changed.`);
