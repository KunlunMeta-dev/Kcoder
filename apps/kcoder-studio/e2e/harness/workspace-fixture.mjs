import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { appRoot } from "./run-context.mjs";

const execFileAsync = promisify(execFile);
const templateBoundary = resolve(appRoot, "e2e/fixtures/workspaces");
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function listWorkspaceTemplates() {
  const entries = await readdir(templateBoundary, { withFileTypes: true });
  const templates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    templates.push(await loadMetadata(entry.name));
  }
  return templates;
}

export async function materializeWorkspace(context, templateId, options = {}) {
  assertSafeId(templateId, "模板 ID");
  const instanceId = options.instanceId || templateId;
  assertSafeId(instanceId, "工作区实例 ID");
  const metadata = await loadMetadata(templateId);
  const templateRoot = checkedTemplatePath(templateId);
  const destination = context.pathInState("workspaces", instanceId);
  await assertMissing(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { recursive: false, mode: 0o700 });

  let gitHead = null;
  try {
    if (metadata.materializer === "copy") {
      await copyTree(templateRoot, destination, { excludedRootNames: new Set([".fixture.json"]) });
    } else if (metadata.materializer === "git-stages") {
      gitHead = await materializeGitStages(templateRoot, destination, metadata.git, options.gitBin || "git");
    } else {
      throw new Error(`不支持的工作区模板 materializer：${metadata.materializer}`);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }

  const sourceDigest = await digestTree(templateRoot);
  context.registerTemporaryDirectory(`workspace:${instanceId}`, destination);
  context.registerWorkspaceFixture({
    id: metadata.id,
    version: metadata.version,
    materializer: metadata.materializer,
    sourceDigest,
    path: destination,
    gitHead,
  });
  return { path: destination, metadata, sourceDigest, gitHead };
}

async function loadMetadata(templateId) {
  assertSafeId(templateId, "模板 ID");
  const root = checkedTemplatePath(templateId);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(resolve(root, ".fixture.json"), "utf8"));
  } catch (error) {
    throw new Error(`无法读取工作区模板 ${templateId} 的 .fixture.json：${error.message}`);
  }
  if (metadata?.schemaVersion !== 1) throw new Error(`工作区模板 ${templateId} 的 schemaVersion 必须为 1`);
  if (metadata.id !== templateId) throw new Error(`工作区模板目录 ${templateId} 与元数据 ID ${metadata.id} 不一致`);
  if (!Number.isInteger(metadata.version) || metadata.version < 1) throw new Error(`工作区模板 ${templateId} 的 version 必须为正整数`);
  if (typeof metadata.description !== "string" || metadata.description.length === 0) throw new Error(`工作区模板 ${templateId} 缺少 description`);
  if (!Array.isArray(metadata.tags) || metadata.tags.some(tag => typeof tag !== "string")) throw new Error(`工作区模板 ${templateId} 的 tags 必须为字符串数组`);
  if (!["copy", "git-stages"].includes(metadata.materializer)) throw new Error(`工作区模板 ${templateId} 使用了未知 materializer`);
  if (metadata.materializer === "git-stages") validateGitMetadata(root, metadata.git);
  return metadata;
}

function validateGitMetadata(templateRoot, git) {
  if (!git || !SAFE_ID.test(git.defaultBranch || "")) throw new Error("git-stages 模板必须声明安全的 defaultBranch");
  if (!Array.isArray(git.stages) || git.stages.length === 0) throw new Error("git-stages 模板至少需要一个 stage");
  for (const [index, stage] of git.stages.entries()) {
    if (!stage || typeof stage.directory !== "string") throw new Error(`git stage ${index} 缺少 directory`);
    checkedChild(templateRoot, stage.directory);
    if (typeof stage.message !== "string" || stage.message.length === 0) throw new Error(`git stage ${index} 缺少 commit message`);
    if (!Number.isInteger(stage.timestamp) || stage.timestamp <= 0) throw new Error(`git stage ${index} 的 timestamp 必须为正整数`);
  }
}

async function materializeGitStages(templateRoot, destination, git, gitBin) {
  await execFileAsync(gitBin, ["init", "--initial-branch", git.defaultBranch, destination], { timeout: 10_000 });
  await execFileAsync(gitBin, ["-C", destination, "config", "user.name", "KCoder E2E Fixture"], { timeout: 5_000 });
  await execFileAsync(gitBin, ["-C", destination, "config", "user.email", "e2e-fixture@kcoder.invalid"], { timeout: 5_000 });
  for (const stage of git.stages) {
    const stageRoot = checkedChild(templateRoot, stage.directory);
    await copyTree(stageRoot, destination);
    await execFileAsync(gitBin, ["-C", destination, "add", "-A"], { timeout: 5_000 });
    const timestamp = new Date(stage.timestamp * 1_000).toISOString();
    await execFileAsync(gitBin, ["-C", destination, "commit", "--quiet", "-m", stage.message], {
      timeout: 10_000,
      env: { ...process.env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
    });
  }
  const { stdout } = await execFileAsync(gitBin, ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
  return stdout.trim();
}

async function copyTree(source, destination, options = {}) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (options.excludedRootNames?.has(entry.name)) continue;
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`工作区模板禁止符号链接：${sourcePath}`);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true, mode: 0o700 });
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`工作区模板只允许普通文件和目录：${sourcePath}`);
    const sourceStat = await stat(sourcePath);
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, sourceStat.mode & 0o777);
  }
}

async function digestTree(root) {
  const hash = createHash("sha256");
  await appendDirectoryDigest(hash, root, root);
  return `sha256:${hash.digest("hex")}`;
}

async function appendDirectoryDigest(hash, root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const relativePath = path.slice(root.length + 1).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`工作区模板禁止符号链接：${path}`);
    if (entry.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      await appendDirectoryDigest(hash, root, path);
    } else if (entry.isFile()) {
      hash.update(`file\0${relativePath}\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    } else {
      throw new Error(`工作区模板只允许普通文件和目录：${path}`);
    }
  }
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`工作区实例已存在，拒绝覆盖：${path}`);
}

function assertSafeId(value, label) {
  if (!SAFE_ID.test(value)) throw new Error(`${label} 不合法：${value}`);
}

function checkedTemplatePath(templateId) {
  return checkedChild(templateBoundary, templateId);
}

function checkedChild(root, ...parts) {
  const path = resolve(root, ...parts);
  if (path === root || !path.startsWith(root + sep)) throw new Error(`工作区模板路径越界：${path}`);
  return path;
}
