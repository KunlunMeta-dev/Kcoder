# TUI Operation, Configuration, and Troubleshooting Boundaries

Read only when the user asks about KCoder TUI copy, Markdown colors, directory location, scroll-back review, or related settings.
The slash commands below such as `/copy` are executed in the KCoder input box, not shell subcommands; do not write them as `kcoder /copy`.

## Distinguish the Problem First

- Operation issue: give the existing entry first, do not turn "how to copy" into a configuration migration or source modification.
- Missing feature or behavior inconsistent with the description: confirm the current CLI entry, run read-only `kcoder doctor`, and check `build commit` and `build dirty`. Looking only at `0.1.0` or the interface title is not enough to distinguish builds; after updating the binary, also restart the old process.
- Configuration not taking effect: use `config get ... --source` below to check scope and override relationships.
- Terminal-related: distinguish between local desktop, SSH, tmux/screen, fullscreen and non-fullscreen, and specific terminal programs as needed. Do not misdiagnose clipboard permissions, shortcuts blocked by the host, or native scroll history limits as Provider/prefill issues.

When the user only requests explanation or diagnosis, do not automatically change configuration, install new versions, trust directories, delete sessions, or push code.
When collecting diagnostics, only provide relevant fields, and avoid pasting the full configuration, credentials, environment variables, or private session content.

## Copying Answers and Code

| Need | Current entry and semantics |
| --- | --- |
| Most recent assistant message | `/copy` or `Ctrl+O`; copies the Markdown source of the last committed non-empty assistant message, not the entire conversation. Text still streaming in the active turn is not included; use the copy view, which also snapshots the active turn |
| Historical answers, single code block, cross-screen selection | `F9` or `/copy view` opens the copy view; the footer navigation bar's "F9 copy" label is also clickable when the TUI receives mouse events |
| Partial content in the copy view | Mouse drag-select, auto-scroll when dragging to top/bottom edges; `Ctrl+C` copies the selection, or copies the entire current entry when there is no non-empty selection |
| Copy full text or switch entries | `Ctrl+A` selects the whole current entry; `←/→` switches between answer/code entries (`Ctrl+Home`/`Ctrl+End` jump to first/last); `↑/↓`, `PageUp/PageDown`, `Home/End` scroll the body; you can also click entries on the left and the `[Copy text]` button |
| Return to conversation | `Esc` or press `F9` again; preserves the unsubmitted input draft |

The copy view preserves the fixed snapshot taken when it was opened. New output continues, but does not rewrite its body or selection; close and reopen to get the latest content.
Selections are bound to the UTF-8 source text positions; scrolling, soft-wrap, and resize do not change the copied content. Answer entries preserve Markdown markup; code entries remove the fence and preserve code indentation, with no message prefix or display line wrapping added.

Mouse selection on the regular chat interface is limited to the current screen. While a selection exists the body is frozen (model and tools keep running) and `Ctrl+C` copies it instead of interrupting; it copies display rows, which may include display line breaks and message prefixes. If the view changed under the selection, KCoder asks to reselect with `F9` or clear with `Esc`. Use the copy view when clean source or cross-screen selection is needed.
When there is no valid selection on the regular interface, `Ctrl+C` falls through to interrupt/exit; do not ask the user to repeatedly press `Ctrl+C` to troubleshoot copy.

Fullscreen (alternate screen) captures the mouse unless the process environment sets `KCODER_TUI_NATIVE_SELECTION=true`, which keeps the host terminal's native selection. Non-fullscreen (inline) mode keeps native host selection and captures the mouse only while the copy view, outline or inline "History" layer is open. So in inline mode, open `F9` or `/copy view` first, then use the mouse inside it; do not promise footer clicks there.

The copy view is a bounded preview, not a complete conversation export: it scans at most the most recent 4096 messages, collects up to 512 assistant message snapshots, with a total source text budget of 8 MiB, and at most 1024 answer/code entries combined.
When the preview or parsing budget is reached, handle per the interface prompt; do not describe a successfully copied current entry as the complete history being exported.

### Linux and Terminal Clipboard

- SSH sessions (`SSH_TTY` or `SSH_CONNECTION` set) always use OSC 52 to hand the copy to the client terminal; the server's desktop clipboard is not tried.
- Locally, the native clipboard comes first; WSL then falls back to `powershell.exe`; OSC 52 is tried only when those channels fail. Lack of SSH identity does not necessarily mean the terminal clipboard cannot be used.
- Inside tmux/screen (`TMUX`/`STY` set) the OSC 52 sequence is wrapped in tmux passthrough; the multiplexer must allow passthrough/clipboard forwarding.
- The OSC 52 current limit is **100,000 raw UTF-8 bytes**, not character count, and not 100 KiB. Exceeding the limit will error; you can segment-select in the copy view; do not claim to copy arbitrarily long answers.
- "Sent an OSC 52 copy request" is not a client confirmation of success. When the user cannot paste the content, check whether the client allows OSC 52 and the forwarding limits of tmux/screen; do not repeatedly change KCoder configuration or credentials.
- Verifying the copy result should paste into a temporary text location and compare the actual text, newlines, and indentation; do not judge success only by selection highlight or status hints.

## Markdown and Theme

KCoder's base Markdown styling uses Cyan inline code, Cyan underlined links, Green blockquotes, and LightBlue ordered numbering; headings use modifiers only (H1 bold+underline, H2 bold, H3 bold+italic, H4–H6 italic), not a colored heading system. Table headers are bold. Only fenced code blocks use the syntax theme (`code_theme`).

In the TUI, `/theme` opens the theme picker; `/theme catppuccin-mocha` or `/theme auto` switches directly. `auto` chooses Catppuccin Mocha (dark) or Catppuccin Latte (light) from the detected terminal background. An unknown name is stored as typed but renders with that adaptive default.

`/raw [on|off]` (or `Alt+R`) toggles raw output mode for the current process: it disables Markdown rendering, expands tool output and uses copy-friendly wrapping; the footer shows `raw output`. `/raw off` does not restore a persisted `render_markdown: false`. `/status` reports `raw` on/off and the render mode (`markdown`/`plain`).

Current streaming messages do not close the entire Markdown just because they exceed **64 KiB**. Syntax highlighting is limited per **single code block**: when exceeding 512 KiB, 10,000 lines, or any line over 4 KiB, that code block falls back to text without syntax color, and surrounding Markdown is not closed as a result. Unmarked or unrecognized code languages may also have no syntax color.
These byte/line limits are not context token caps, nor existing settings parameters; do not invent "raise streaming Markdown threshold" configuration keys.

For color anomalies, first check `/status` (raw and render mode), `render_markdown`, `code_theme`, the code language, and the above limits. If a message loses color across the board without exceeding limits, further confirm the build and reproduction conditions; do not directly attribute it to refresh frame rate or ask the user to keep enlarging the context window.

## Truly Configurable Settings

First read the effective value and source:

```bash
kcoder config get render_markdown --source
kcoder config get code_theme --source
kcoder config get tui.alternate_screen --source
```

- `render_markdown`: boolean, default `true`.
- `code_theme`: syntax theme name (string), default `auto`; confirm available names from the current build's `/theme` picker.
- `tui.alternate_screen`: `auto`, `always`, `never` (booleans are accepted as `always`/`never`), default `auto`. `auto` currently enters the alternate screen just like `always`; choose `never` for inline mode. The process environment variable `KCODER_TUI_ALT_SCREEN` (same values) overrides the setting, and the global flag `--no-alt-screen` forces inline mode for the current process; neither is a settings field.

Use explicit scopes only when the user requests persisting preferences, e.g.:

```bash
kcoder config set code_theme catppuccin-mocha --scope user
kcoder config validate
```

`/theme <name>` also tries to write `code_theme` to the user settings file, but a failed or disabled write is only logged; the TUI still reports "Theme switched". Seeing a theme switch therefore does not prove persistence; check `config get code_theme --source` and a new session.
Do not create new settings fields for opening F9/F8, changing fixed copy budgets, or solving terminal clipboard permissions.

## Directory Location and Scroll-Back Review

- `F8` or `/outline [query]` opens the conversation outline, locate by task, answer, or title; you can also click outline entries.
- `/jump start` locates the start of the current-turn answer (when there is no current location, uses the most recent turn as the anchor), not the first line of the entire conversation.
- `/jump prev`, `/jump next` switch between previous and next tasks; `/jump latest` returns to the latest output. When the footer is wide enough (80+ columns) and the conversation is non-empty, its navigation bar (`F8 outline`, `F9 copy`, `start`, `latest`) offers the same actions by click.
- During review, new output does not forcibly pull the user back to the bottom; `↓ Back to bottom · Esc` (click or `Esc`) resumes following while keeping the draft. Directory location in non-fullscreen mode uses the in-app "History" layer, which is not equivalent to the host terminal scrollback.
- In the conversation and copy-view body, each wheel event received by KCoder moves three display rows (over the copy-view entry list it moves the selection by three entries). Fast or slow input uses the same step, and consecutive events retain their displacement even when several arrive before the next paint. Ordinary history scrolling uses the actual painted row as its next starting position. Long-history windows measure visited messages and preserve the same source message and display row as estimates are refined; Markdown tables, wrapping and collapsed tool records must not turn a three-row event into a jump between sections. The host terminal may emit several events for one physical wheel notch; this is not a promise of three rows per notch or a configurable speed setting.
- F8 is the location outline, F9 is the copy snapshot; we currently cannot promise to copy sections directly within the F8 outline.
- Navigation, highlighting, and copy each have their own resource budgets. A location budget error does not mean history is lost, nor can it be fixed by changing `code_theme` or inventing threshold parameters.

If stable skipping lines, blank bands, misalignment, or selection content changes occur, record the build, terminal size, mode, phase, and minimum reproduction. Source fixes should be verified with real terminal behavior; do not use a README update or a single `doctor` success in place of interactive verification.


## Context remaining indicator

The footer shows `<percent> context left`, plus estimated used / available input budget (the configured window minus output headroom) on wide footers. Near-full percentages keep finer precision and nonzero use shows `<100%` rather than a false 100%. With an unknown budget it shows `context unknown`, or `<N> used` once usage is known. The color turns warning at 85% used and error at 95%. With a 100,000,000-token window, tens of thousands of tokens use a small fraction, so inspect both counts instead of assuming the usage is frozen. `/status` shows the same remaining label along with model/window settings. These are display changes, not changes to context limits, output headroom or compaction thresholds.
