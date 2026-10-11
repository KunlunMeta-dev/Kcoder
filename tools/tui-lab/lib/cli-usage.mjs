export const usage = `Usage:
  npm run open -- [--scenario full-turn] [--cols 100] [--rows 32]
  npm run run -- [--scenario full-turn] [--message TEXT] [--out target/tui-lab]
  npm run inline -- [--scenario full-turn] [--message TEXT] [--out target/tui-lab]
  npm run two-turn -- [--scenario full-turn] [--message TEXT] [--second-message TEXT]
  npm run slash-overlay -- [--scenario full-turn] [--out target/tui-lab]
  npm run external-editor -- [--scenario full-turn] [--out target/tui-lab]
  npm run slash-after-history -- [--scenario full-turn] [--out target/tui-lab]
  npm run goal-command -- [--scenario full-turn] [--out target/tui-lab]
  npm run run -- --scenario subagent-trace [--out target/tui-lab]
  npm run targeted-subagent-steer -- [--out target/tui-lab]
  npm run targeted-subagent-stop -- [--out target/tui-lab]
  npm run lsp-diagnostics -- [--out target/tui-lab]
  npm run ocr-review -- [--out target/tui-lab]
  npm run streaming-scrollbar -- [--stream-delay-ms 80] [--out target/tui-lab]
  npm run history-scrollbar -- --history PATH [--fallback-history PATH] [--drag-duration-ms 6000] [--video-fps 30]
  node bin/tui-lab.mjs wheel-precision --description message-window-row-continuity --software-webgl
  npm run clipboard -- [--scenario full-turn] [--out target/tui-lab]
  npm run copy-view -- --description copy-view-linux [--software-webgl] [--out target/tui-lab]
  node bin/tui-lab.mjs model-refresh --description model-hot-reload --out target/tui-lab
  npm run tail-menu -- --description tail-follow-menu [--software-webgl] [--out target/tui-lab]
  npm run image-paste -- [--scenario full-turn] [--out target/tui-lab]
  npm run history-search -- [--scenario full-turn] [--out target/tui-lab]
  npm run mention -- [--scenario full-turn] [--out target/tui-lab]
  npm run paste -- [--scenario full-turn] [--out target/tui-lab]
  npm run shell-prompt -- [--scenario full-turn] [--out target/tui-lab]
  npm run session-memory-compact -- [--scenario full-turn] [--out target/tui-lab]
  npm run session-resume -- [--scenario full-turn] [--out target/tui-lab]
  npm run resize-visual -- [--scenario full-turn] [--out target/tui-lab]
  node bin/tui-lab.mjs response-budget --scenario tail-follow --stream-delay-ms 10 --software-webgl
  npm run record -- [--command TEXT] [--send-message] [--record-seconds 30] [--sample-fps 1]
  npm run startup -- [--command TEXT] [--out target/tui-lab]
  npm run outline-navigation -- [--outline-inline] [--outline-streaming] [--out target/tui-lab]
  npm run screenshot -- [--scenario full-turn] [--out target/tui-lab]
  npm run tmux:startup -- [--command TEXT] [--out target/tui-lab]
  npm run tmux:smoke -- [--scenario full-turn] [--out target/tui-lab]

Options:
  --command TEXT       Override the default cargo command.
  --description TEXT   Description used in the run directory name.
  --message TEXT       Text inserted into the TUI composer before Enter.
  --second-message TEXT
                       Text inserted after the first turn completes in two-turn mode.
  --steer-after-tool   In two-turn mode, submit the second message while the first tool is still running.
  --out PATH           Base output directory. Outside the repository it must already be a private,
                       current-user-owned trusted directory; pathname checks cannot provide openat isolation.
  --workspace-template PATH
                       Template workspace copied into each timestamped run directory.
  --scenario NAME      Mock scenario passed to kcoder tui-dev.
  --cols N             PTY columns. Default: 100.
  --rows N             PTY rows. Default: 32.
  --timeout-ms N       Wait timeout. Default: 180000.
  --record-seconds N   Record duration for record mode. Default: 30.
  --sample-fps N       Timeline/video-frame sampling rate for record mode. Default: 1.
  --video-fps N        Compressed video frame rate for record mode. Default: 6.
  --stream-delay-ms N  Delay each tui-dev mock stream event by N ms. Default: 0, or 80 for streaming-scrollbar.
  --history PATH       Existing JSONL history to resume for history-scrollbar.
  --history-workspace PATH
                       Working directory that owns --history. Required when it differs from the new artifact workspace.
  --fallback-history PATH
                       Secondary JSONL history to try if --history is unavailable.
  --drag-duration-ms N Duration for history-scrollbar's held drag gesture. Default: 980.
  --drag-samples N     Number of samples during history-scrollbar's held drag. Default: 14.
  --send-message       In record mode, type --message after the welcome screen and press Enter.
  --headed             Run Playwright with a visible browser for run/screenshot.
  --headless           Run Playwright headless for open/run/screenshot.
  --software-webgl     Explicitly use ANGLE SwiftShader for WebGL screenshots.
  --outline-inline     Verify outline-navigation using the managed inline history layer.
  --outline-streaming  Also verify lookback while a deterministic mock turn completes.
  --copy-inline        Verify copy-view in Linux inline mode, entering with F9.
`;
