import { spawn } from "node:child_process";
import { access, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(studioRoot, "package.json"), "utf8"));
const outputDirectory = resolve(studioRoot, "../../target/packages/kcoder-studio/windows-remote");
const unpackedDirectory = resolve(outputDirectory, "win-unpacked");
const archive = resolve(
  outputDirectory,
  `KCoder-Studio-Remote-${packageJson.version}-win-x64.zip`,
);
const temporaryArchive = `${archive}.${process.pid}.tmp.zip`;

await access(resolve(unpackedDirectory, "kcoder-studio-remote.exe"), constants.R_OK);
await access(resolve(unpackedDirectory, "resources", "app.asar"), constants.R_OK);

await rm(temporaryArchive, { force: true });
const sevenZip = process.env.SEVEN_ZIP_BIN || "7z";
const child = spawn(
  sevenZip,
  ["a", "-tzip", "-mx=5", temporaryArchive, "./win-unpacked/*"],
  { cwd: outputDirectory, stdio: "inherit" },
);
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code));
});
if (exitCode !== 0) {
  await rm(temporaryArchive, { force: true });
  throw new Error(`${sevenZip} 创建 Windows ZIP 失败，退出码 ${String(exitCode)}`);
}
await rename(temporaryArchive, archive);
console.log(`KCoder Studio Windows remote package: ${archive}`);
