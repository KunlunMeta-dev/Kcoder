#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"
cd "$repo_dir"

usage() {
  echo "Usage: scripts/audit/audit_tui_manual_checklist.sh"
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument: $1"
      usage
      exit 2
      ;;
  esac
fi

today="$(date +%F)"
maintainer="${MAINTAINER:-<maintainer>}"
kcoder_cmd="${KCODER_TUI_COMMAND:-./target/release/kcoder}"
console="<terminal>"
if [[ -t 1 ]]; then
  console="$(tty)"
fi

tool_status() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf 'available'
  else
    printf 'missing'
  fi
}

echo "== KCoder TUI manual checklist =="
echo
echo "This script prints repeatable real-terminal checks and evidence lines."
echo "Manual observation is required; this script does not verify pass/fail."
echo
echo "Context:"
echo "- repo: $repo_dir"
echo "- date: $today"
echo "- maintainer field: $maintainer"
echo "- console field: $console"
echo "- TUI command: $kcoder_cmd"
echo
echo "Helper availability:"
echo "- stty: $(tool_status stty)"
echo "- pgrep: $(tool_status pgrep)"
echo "- kill: $(tool_status kill)"
echo "- script: $(tool_status script)"
echo
echo "Before starting:"
echo "1. Run this from a real terminal, not a CI log or non-interactive pipe."
echo "2. Build or select the TUI binary you will use."
echo "3. Set MAINTAINER and KCODER_TUI_COMMAND if the defaults are not correct."
echo "4. Do not paste secrets into the terminal transcript or signoff file."
echo "5. Replace any angle-bracket values before copying evidence into the signoff file."
echo
echo "Check 1: TUI_PANIC_RECOVERY_OK"
echo "- Start the TUI with: $kcoder_cmd"
echo "- Trigger the project-approved controlled panic path."
echo "- After the process exits, run: stty -a"
echo "- Confirm input mode, cursor visibility, mouse behavior, SGR state, and scroll region are normal."
echo "Evidence line:"
echo "- TUI panic recovery: $today maintainer=$maintainer console=$console command=\"controlled TUI panic, then stty -a\" observed=\"raw mode off; cursor visible; mouse input normal; SGR and scroll region restored\""
echo
echo "Check 2: TUI_SIGTERM_RECOVERY_OK"
echo "- Start the TUI with: $kcoder_cmd"
echo "- In another terminal, identify the PID with: pgrep -af 'kcoder'"
echo "- Terminate the chosen process with: kill -TERM <pid>"
echo "- Confirm the original terminal can type, copy, scroll, and show the cursor normally."
echo "Evidence line:"
echo "- TUI SIGTERM recovery: $today maintainer=$maintainer console=$console command=\"kill -TERM <pid>, then stty -a\" observed=\"terminal input, cursor, mouse, copy, and scroll behavior normal\""
echo
echo "Check 3: TUI_HIGH_SPEED_STREAM_OK"
echo "- Start a long high-speed streaming response in the TUI."
echo "- While streaming, type text, use navigation keys, and open or close lightweight UI controls."
echo "- Confirm keyboard input remains responsive while spinner and background hints update."
echo "Evidence line:"
echo "- TUI high-speed stream: $today maintainer=$maintainer console=$console command=\"long streaming TUI response while typing\" observed=\"keyboard input stayed responsive and low-priority events did not starve input\""
echo
echo "Check 4: TUI_UNICODE_EDIT_OK"
echo "- Open a permission editor flow."
echo "- Enter: 中文🙂🚀abc"
echo "- Move by character, delete characters, and force line wrapping with additional text."
echo "- Confirm visual cursor position, deletion, and wrapped-line positioning are correct."
echo "Evidence line:"
echo "- TUI Unicode editing: $today maintainer=$maintainer console=$console command=\"permission editor with Chinese and Emoji text\" observed=\"cursor movement, deletion, and wrapped-line positioning were visually correct\""
echo
echo "After all checks:"
echo "1. Copy the matching evidence lines into AUDIT_REMEDIATION_MANUAL_SIGNOFF.md."
echo "2. Change the four TUI checkboxes to [x] only after the observations are complete."
echo "3. Run: scripts/audit/audit_manual_release_gate.sh"
