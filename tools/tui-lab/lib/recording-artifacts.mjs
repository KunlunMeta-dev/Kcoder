import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { mkdirSync as nodeMkdirSync, readdirSync as nodeReaddirSync } from 'node:fs';
import { rename as nodeRename } from 'node:fs/promises';
import path from 'node:path';

export const RECORDING_FRAME_FORMAT = 'webp';
export const RECORDING_FRAME_QUALITY = 0;
export const RECORDING_TRIM_LEADING_SECONDS = 0.5;
export const RECORDING_PAGE_TIMEOUT_MS = 5000;
export const RECORDING_COMMAND_TIMEOUT_MS = 120000;

export function remainingDeadlineMs(deadlineMs, runtime = {}, capMs = Number.POSITIVE_INFINITY) {
  const now = runtime.now || Date.now;
  return Math.max(0, Math.min(capMs, deadlineMs - now()));
}

function commandTimeout(runtime) {
  return runtime.deadlineMs == null
    ? runtime.commandTimeoutMs || RECORDING_COMMAND_TIMEOUT_MS
    : Math.max(1, remainingDeadlineMs(runtime.deadlineMs, runtime, runtime.commandTimeoutMs || RECORDING_COMMAND_TIMEOUT_MS));
}

export async function withinAbsoluteDeadline(promise, deadlineMs, label, runtime = {}) {
  const now = runtime.now || Date.now;
  const setTimer = runtime.setTimeout || setTimeout;
  const clearTimer = runtime.clearTimeout || clearTimeout;
  const remainingMs = Math.max(0, deadlineMs - now());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      const error = new Error(`${label} exceeded its absolute deadline`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, remainingMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

export async function collectRecordingTimelineSamples({
  page,
  artifacts,
  timeline,
  startedAtMs,
  options,
  shouldStop,
  runtime = {},
}) {
  const intervalMs = Math.max(100, Math.round(1000 / options.sampleFps));
  const now = runtime.now || Date.now;
  const isoNow = runtime.isoNow || (() => new Date().toISOString());
  const sleep = runtime.sleep || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  const deadlineMs = runtime.deadlineMs ?? Number.POSITIVE_INFINITY;
  const pageTimeoutMs = runtime.pageTimeoutMs ?? RECORDING_PAGE_TIMEOUT_MS;
  let index = 0;
  while (!shouldStop() && now() < deadlineMs) {
    const atMs = now() - startedAtMs;
    const file = path.join(artifacts.recordingSamplesDir, `sample-${String(index).padStart(4, '0')}.png`);
    try {
      const operationDeadline = Math.min(deadlineMs, now() + pageTimeoutMs);
      await withinAbsoluteDeadline(
        page.screenshot({ path: file }),
        operationDeadline,
        'recording screenshot',
        runtime,
      );
      const [text, dimensions, hasScrollbar] = await withinAbsoluteDeadline(
        Promise.all([
          page.evaluate(() => window.tuiLab?.text?.() || ''),
          page.evaluate(() => window.tuiLab?.dimensions?.() || null),
          page.evaluate(() => window.tuiLab?.hasScrollbar?.() || false),
        ]),
        operationDeadline,
        'recording page evaluation',
        runtime,
      );
      timeline.samples.push({
        index,
        atMs,
        at: isoNow(),
        file,
        text,
        dimensions,
        hasScrollbar,
      });
    } catch (error) {
      timeline.samples.push({
        index,
        atMs,
        at: isoNow(),
        file,
        error: formatError(error),
      });
    }
    index += 1;
    const remainingMs = deadlineMs - now();
    if (!shouldStop() && remainingMs > 0) {
      await sleep(Math.min(intervalMs, remainingMs));
    }
  }
}

export async function moveRecordedVideo(video, destination, runtime = {}) {
  if (!video) {
    return null;
  }
  let source;
  try {
    const now = runtime.now || Date.now;
    source = await withinAbsoluteDeadline(
      video.path(),
      runtime.deadlineMs ?? now() + RECORDING_PAGE_TIMEOUT_MS,
      'Playwright video path',
      runtime,
    );
  } catch {
    return null;
  }
  if (!source || source === destination) {
    return source || null;
  }
  await (runtime.rename || nodeRename)(source, destination);
  return destination;
}

export function commandExists(command, runtime = {}) {
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const result = spawnSync(command, ['-version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: commandTimeout(runtime),
  });
  return result.status === 0;
}

export function compressVideo(input, output, fps, runtime = {}) {
  if (!commandExists('ffmpeg', runtime)) {
    return { ok: false, skipped: true, reason: 'ffmpeg not found on PATH' };
  }
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(RECORDING_TRIM_LEADING_SECONDS),
    '-i',
    input,
    '-vf',
    `fps=${fps},scale=iw:-2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryslow',
    '-crf',
    '38',
    '-pix_fmt',
    'yuv420p',
    '-an',
    output,
  ];
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    timeout: commandTimeout(runtime),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      command: 'ffmpeg',
      args,
      status: result.status,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    command: 'ffmpeg',
    args,
    output,
    trimLeadingSeconds: RECORDING_TRIM_LEADING_SECONDS,
  };
}

export function extractVideoFrames(input, outputDir, fps, runtime = {}) {
  if (!commandExists('ffmpeg', runtime)) {
    return { ok: false, skipped: true, reason: 'ffmpeg not found on PATH' };
  }
  const mkdirSync = runtime.mkdirSync || nodeMkdirSync;
  const readdirSync = runtime.readdirSync || nodeReaddirSync;
  mkdirSync(outputDir, { recursive: true });
  const pattern = path.join(outputDir, `frame-%04d.${RECORDING_FRAME_FORMAT}`);
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `fps=${fps}`,
    '-c:v',
    'libwebp',
    '-quality',
    String(RECORDING_FRAME_QUALITY),
    '-compression_level',
    '6',
    pattern,
  ];
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    timeout: commandTimeout(runtime),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      command: 'ffmpeg',
      args,
      status: result.status,
      stderr: result.stderr,
    };
  }
  let frameCount = 0;
  try {
    frameCount = readdirSync(outputDir).filter((file) => file.endsWith(`.${RECORDING_FRAME_FORMAT}`)).length;
  } catch {
    frameCount = 0;
  }
  return {
    ok: true,
    command: 'ffmpeg',
    args,
    outputDir,
    pattern,
    frameFormat: RECORDING_FRAME_FORMAT,
    frameQuality: RECORDING_FRAME_QUALITY,
    frameCount,
  };
}

export function probeVideo(input, runtime = {}) {
  if (!commandExists('ffprobe', runtime)) {
    return { ok: false, skipped: true, reason: 'ffprobe not found on PATH' };
  }
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate',
    '-of',
    'json',
    input,
  ];
  const spawnSync = runtime.spawnSync || nodeSpawnSync;
  const result = spawnSync('ffprobe', args, {
    encoding: 'utf8',
    timeout: commandTimeout(runtime),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      command: 'ffprobe',
      args,
      status: result.status,
      stderr: result.stderr,
    };
  }
  try {
    const data = JSON.parse(result.stdout);
    const contractError = validateVideoProbeData(data);
    if (contractError) {
      return { ok: false, command: 'ffprobe', args, reason: contractError, data };
    }
    return {
      ok: true,
      command: 'ffprobe',
      args,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      command: 'ffprobe',
      args,
      error: formatError(error),
      stdout: result.stdout,
    };
  }
}

export function validateVideoProbeData(data) {
  const video = data?.streams?.find((stream) => typeof stream?.codec_name === 'string');
  if (!video?.codec_name) return 'ffprobe reported no video codec';
  if (!(Number(video.width) > 0) || !(Number(video.height) > 0)) return 'ffprobe reported invalid video dimensions';
  if (!(Number(data?.format?.duration) > 0)) return 'ffprobe reported non-positive duration';
  if (!(Number(data?.format?.size) > 0)) return 'ffprobe reported non-positive size';
  return null;
}

export function validateRecordingSuccess({ timeline, rawVideo, compression, videoProbe, extractedFrames }) {
  const failures = [];
  if (!Array.isArray(timeline?.samples) || timeline.samples.length === 0) {
    failures.push('timeline has zero samples');
  } else if (!timeline.samples.some((sample) => !sample.error)) {
    failures.push('all timeline samples failed');
  }
  if (!rawVideo) failures.push('Playwright produced no raw video');
  if (!compression?.ok) failures.push(`video compression failed: ${compression?.reason || compression?.stderr || 'unknown'}`);
  if (!videoProbe?.ok) failures.push(`video probe failed: ${videoProbe?.reason || videoProbe?.stderr || 'unknown'}`);
  if (!extractedFrames?.ok) {
    failures.push(`video frame extraction failed: ${extractedFrames?.reason || extractedFrames?.stderr || 'unknown'}`);
  } else if (!(extractedFrames.frameCount > 0)) {
    failures.push('video frame extraction produced zero frames');
  }
  if (failures.length > 0) {
    const error = new Error(`recording success contract failed: ${failures.join('; ')}`);
    error.recordingFailures = failures;
    throw error;
  }
  return true;
}

function formatError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
    code: error?.code,
  };
}
