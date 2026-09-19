import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RECORDING_FRAME_FORMAT,
  RECORDING_FRAME_QUALITY,
  RECORDING_TRIM_LEADING_SECONDS,
  collectRecordingTimelineSamples,
  commandExists,
  compressVideo,
  extractVideoFrames,
  moveRecordedVideo,
  probeVideo,
  validateRecordingSuccess,
} from '../lib/recording-artifacts.mjs';

function spawnSequence(results) {
  const calls = [];
  return {
    calls,
    spawnSync(command, args, options) {
      calls.push({ command, args: [...args], options });
      return results.shift() || { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('records bounded timeline samples and preserves screenshot errors as evidence', async () => {
  const timeline = { samples: [] };
  const sleeps = [];
  let stopped = false;
  const page = {
    async screenshot() {
      throw new Error('sample capture failed');
    },
    async evaluate() {
      assert.fail('evaluation must not run after a failed screenshot');
    },
  };

  await collectRecordingTimelineSamples({
    page,
    artifacts: { recordingSamplesDir: '/artifacts/recording-samples' },
    timeline,
    startedAtMs: 900,
    options: { sampleFps: 100 },
    shouldStop: () => stopped,
    runtime: {
      now: () => 1_000,
      isoNow: () => '2026-07-30T00:00:01.000Z',
      async sleep(duration) {
        sleeps.push(duration);
        stopped = true;
      },
    },
  });

  assert.deepEqual(sleeps, [100]);
  assert.equal(timeline.samples.length, 1);
  assert.equal(timeline.samples[0].index, 0);
  assert.equal(timeline.samples[0].atMs, 100);
  assert.equal(timeline.samples[0].file, '/artifacts/recording-samples/sample-0000.png');
  assert.equal(timeline.samples[0].error.name, 'Error');
  assert.equal(timeline.samples[0].error.message, 'sample capture failed');
});

test('records successful timeline text, dimensions, scrollbar state, and stable sample naming', async () => {
  const timeline = { samples: [] };
  let stopped = false;
  const evaluations = ['terminal text', { cols: 100, rows: 32 }, true];
  const screenshotCalls = [];
  const page = {
    async screenshot(options) {
      screenshotCalls.push(options);
    },
    async evaluate() {
      return evaluations.shift();
    },
  };

  await collectRecordingTimelineSamples({
    page,
    artifacts: { recordingSamplesDir: '/samples' },
    timeline,
    startedAtMs: 5_000,
    options: { sampleFps: 2 },
    shouldStop: () => stopped,
    runtime: {
      now: () => 5_125,
      isoNow: () => '2026-07-30T00:00:05.125Z',
      async sleep(duration) {
        assert.equal(duration, 500);
        stopped = true;
      },
    },
  });

  assert.deepEqual(screenshotCalls, [{ path: '/samples/sample-0000.png' }]);
  assert.deepEqual(timeline.samples, [
    {
      index: 0,
      atMs: 125,
      at: '2026-07-30T00:00:05.125Z',
      file: '/samples/sample-0000.png',
      text: 'terminal text',
      dimensions: { cols: 100, rows: 32 },
      hasScrollbar: true,
    },
  ]);
});

test('bounds a never-settling page sample by one absolute deadline', async () => {
  const timeline = { samples: [] };
  const startedAtMs = Date.now();
  await collectRecordingTimelineSamples({
    page: {
      screenshot: () => new Promise(() => {}),
      evaluate: () => assert.fail('evaluation must not follow a timed-out screenshot'),
    },
    artifacts: { recordingSamplesDir: '/samples' },
    timeline,
    startedAtMs,
    options: { sampleFps: 10 },
    shouldStop: () => false,
    runtime: { deadlineMs: startedAtMs + 20, pageTimeoutMs: 1000 },
  });
  assert.equal(timeline.samples.length, 1);
  assert.equal(timeline.samples[0].error.code, 'ETIMEDOUT');
  assert.match(timeline.samples[0].error.message, /absolute deadline/);
});

test('handles absent Playwright video and renames the raw recording exactly once', async () => {
  assert.equal(await moveRecordedVideo(null, '/artifacts/recording.raw.webm'), null);
  assert.equal(
    await moveRecordedVideo({ path: async () => '' }, '/artifacts/recording.raw.webm'),
    null,
  );
  assert.equal(
    await moveRecordedVideo({ path: async () => '/same.webm' }, '/same.webm'),
    '/same.webm',
  );

  const renames = [];
  const moved = await moveRecordedVideo(
    { path: async () => '/playwright/video.webm' },
    '/artifacts/recording.raw.webm',
    {
      async rename(source, destination) {
        renames.push([source, destination]);
      },
    },
  );
  assert.equal(moved, '/artifacts/recording.raw.webm');
  assert.deepEqual(renames, [['/playwright/video.webm', '/artifacts/recording.raw.webm']]);
});

test('bounds a never-settling Playwright video path lookup', async () => {
  const now = Date.now();
  assert.equal(
    await moveRecordedVideo(
      { path: () => new Promise(() => {}) },
      '/artifacts/recording.raw.webm',
      { deadlineMs: now + 10 },
    ),
    null,
  );
});

test('builds the exact ffmpeg compression argv and reports nonzero exits', () => {
  assert.equal(RECORDING_TRIM_LEADING_SECONDS, 0.5);
  const success = spawnSequence([
    { status: 0, stdout: 'ffmpeg version', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ]);
  const result = compressVideo('/raw.webm', '/recording.mp4', 6, success);
  assert.equal(result.ok, true);
  assert.deepEqual(success.calls[0].args, ['-version']);
  assert.equal(success.calls[0].options.timeout, 120000);
  assert.deepEqual(success.calls[1].args, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    '0.5',
    '-i',
    '/raw.webm',
    '-vf',
    'fps=6,scale=iw:-2',
    '-c:v',
    'libx264',
    '-preset',
    'veryslow',
    '-crf',
    '38',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '/recording.mp4',
  ]);
  assert.equal(success.calls[1].options.timeout, 120000);

  const failure = spawnSequence([
    { status: 0, stdout: 'ffmpeg version', stderr: '' },
    { status: 23, stdout: '', stderr: 'encoding failed' },
  ]);
  assert.deepEqual(compressVideo('/raw.webm', '/recording.mp4', 12, failure), {
    ok: false,
    command: 'ffmpeg',
    args: failure.calls[1].args,
    status: 23,
    stderr: 'encoding failed',
  });
});

test('recomputes external command timeout from the shared scenario deadline', () => {
  const calls = [];
  const times = [100, 250];
  const result = compressVideo('/raw.webm', '/recording.mp4', 6, {
    deadlineMs: 1000,
    now: () => times.shift() ?? 250,
    spawnSync(command, args, options) {
      calls.push({ command, args, timeout: options.timeout });
      return { status: 0, stdout: 'ffmpeg version', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.timeout), [900, 750]);
});

test('returns structured skipped evidence when ffmpeg or ffprobe is missing', () => {
  const missing = {
    spawnSync(command, args) {
      assert.deepEqual(args, ['-version']);
      return { status: null, error: new Error(`${command} missing`) };
    },
  };
  assert.equal(commandExists('ffmpeg', missing), false);
  assert.deepEqual(compressVideo('/raw.webm', '/recording.mp4', 6, missing), {
    ok: false,
    skipped: true,
    reason: 'ffmpeg not found on PATH',
  });
  assert.deepEqual(extractVideoFrames('/raw.webm', '/frames', 1, missing), {
    ok: false,
    skipped: true,
    reason: 'ffmpeg not found on PATH',
  });
  assert.deepEqual(probeVideo('/raw.webm', missing), {
    ok: false,
    skipped: true,
    reason: 'ffprobe not found on PATH',
  });
});

test('extracts WebP frames with stable argv, naming, quality, compression, and count', () => {
  assert.equal(RECORDING_FRAME_FORMAT, 'webp');
  assert.equal(RECORDING_FRAME_QUALITY, 0);
  const runtime = spawnSequence([
    { status: 0, stdout: 'ffmpeg version', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ]);
  const mkdirCalls = [];
  runtime.mkdirSync = (directory, options) => mkdirCalls.push([directory, options]);
  runtime.readdirSync = () => ['frame-0001.webp', 'frame-0002.webp', 'notes.txt'];

  const result = extractVideoFrames('/recording.mp4', '/frames', 2, runtime);
  assert.equal(result.ok, true);
  assert.equal(result.pattern, '/frames/frame-%04d.webp');
  assert.equal(result.frameCount, 2);
  assert.deepEqual(mkdirCalls, [['/frames', { recursive: true }]]);
  assert.deepEqual(runtime.calls[1].args, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    '/recording.mp4',
    '-vf',
    'fps=2',
    '-c:v',
    'libwebp',
    '-quality',
    '0',
    '-compression_level',
    '6',
    '/frames/frame-%04d.webp',
  ]);
});

test('reports frame extraction nonzero exits without counting stale files', () => {
  const runtime = spawnSequence([
    { status: 0, stdout: 'ffmpeg version', stderr: '' },
    { status: 9, stdout: '', stderr: 'decode failed' },
  ]);
  let read = false;
  runtime.mkdirSync = () => {};
  runtime.readdirSync = () => {
    read = true;
    return ['stale.webp'];
  };
  const result = extractVideoFrames('/recording.mp4', '/frames', 1, runtime);
  assert.equal(result.ok, false);
  assert.equal(result.status, 9);
  assert.equal(result.stderr, 'decode failed');
  assert.equal(read, false);
});

test('probes JSON metadata and returns structured nonzero and malformed-JSON failures', () => {
  const success = spawnSequence([
    { status: 0, stdout: 'ffprobe version', stderr: '' },
    { status: 0, stdout: '{"streams":[{"codec_name":"h264","width":980,"height":650}],"format":{"duration":"2.0","size":"1234"}}', stderr: '' },
  ]);
  const probed = probeVideo('/recording.mp4', success);
  assert.equal(probed.ok, true);
  assert.equal(probed.data.streams[0].codec_name, 'h264');
  assert.deepEqual(success.calls[1].args, [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate',
    '-of',
    'json',
    '/recording.mp4',
  ]);

  const nonzero = spawnSequence([
    { status: 0, stdout: 'ffprobe version', stderr: '' },
    { status: 4, stdout: '', stderr: 'probe failed' },
  ]);
  const failed = probeVideo('/recording.mp4', nonzero);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 4);
  assert.equal(failed.stderr, 'probe failed');

  const malformed = spawnSequence([
    { status: 0, stdout: 'ffprobe version', stderr: '' },
    { status: 0, stdout: '{bad json', stderr: '' },
  ]);
  const badJson = probeVideo('/recording.mp4', malformed);
  assert.equal(badJson.ok, false);
  assert.equal(badJson.command, 'ffprobe');
  assert.equal(badJson.stdout, '{bad json');
  assert.match(badJson.error.message, /JSON/);

  const invalidContract = spawnSequence([
    { status: 0, stdout: 'ffprobe version', stderr: '' },
    { status: 0, stdout: '{"streams":[{"codec_name":"h264","width":0,"height":650}],"format":{"duration":"0","size":"0"}}', stderr: '' },
  ]);
  const invalid = probeVideo('/recording.mp4', invalidContract);
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /dimensions|duration|size/);
});

test('rejects zero samples and all-error samples as recording success', () => {
  const otherwiseHealthy = {
    rawVideo: '/raw.webm',
    compression: { ok: true },
    videoProbe: { ok: true },
    extractedFrames: { ok: true, frameCount: 1 },
  };
  assert.throws(
    () => validateRecordingSuccess({ ...otherwiseHealthy, timeline: { samples: [] } }),
    /zero samples/,
  );
  assert.throws(
    () =>
      validateRecordingSuccess({
        ...otherwiseHealthy,
        timeline: { samples: [{ error: { message: 'one' } }, { error: { message: 'two' } }] },
      }),
    /all timeline samples failed/,
  );
});

test('rejects nonzero media failures and zero extracted frames', () => {
  const healthy = {
    timeline: { samples: [{ text: 'ok' }] },
    rawVideo: '/raw.webm',
    compression: { ok: true },
    videoProbe: { ok: true },
    extractedFrames: { ok: true, frameCount: 1 },
  };
  assert.throws(
    () => validateRecordingSuccess({ ...healthy, compression: { ok: false, stderr: 'exit 9' } }),
    /compression failed.*exit 9/,
  );
  assert.throws(
    () => validateRecordingSuccess({ ...healthy, extractedFrames: { ok: true, frameCount: 0 } }),
    /zero frames/,
  );
});

test('record scenario owns one terminal failure write after bounded cleanup', async () => {
  const runner = await readFile(new URL('../bin/tui-lab.mjs', import.meta.url), 'utf8');
  const start = runner.indexOf('async function runRecordingScenario');
  const end = runner.indexOf('\nfunction scenarioToolNeedle', start);
  const source = runner.slice(start, end);
  assert.match(source, /scenarioDeadlineMs/);
  assert.match(source, /cleanupReserveMs/);
  assert.match(source, /captureFailurePageEvidence/);
  assert.equal(source.match(/writeFailureArtifacts\(/g)?.length, 1);
  assert.match(source, /pageEvidence,/);
});
