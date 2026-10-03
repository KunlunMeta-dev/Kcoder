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
| Most recent assistant message | `/copy` or `Ctrl+O`; copies the Markdown source of that message, not the entire conversation, and is not guaranteed to include all streaming fragments of one task turn |
| Historical answers, single code block, cross-screen selection | `F9` or `/copy view` opens the copy view; in fullscreen mode you can also click the bottom bar's "F9 copy" |
| Partial content in the copy view | Mouse drag-select, auto-scroll when dragging to top/bottom edges; `Ctrl+C` copies the selection, or copies the entire current entry when there is no non-empty selection |
| Copy full text or switch entries | `Ctrl+A` selects all; `←/→` switches between answer/code entries; you can also click entries on the left and the "Copy text" button |
| Return to conversation | `Esc` or press `F9` again; preserves the unsubmitted input draft |

The copy view preserves the fixed snapshot taken when it was opened. New output continues, but does not rewrite its body or selection; close and reopen to get the latest content.
Selections are bound to the UTF-8 source text positions; scrolling, soft-wrap, and resize do not change the copied content. Answer entries preserve Markdown markup; code entries remove the fence and preserve code indentation, with no message prefix or display line wrapping added.

Mouse selection on the regular chat interface is still limited to the current screen: it will not switch to copying other text after refresh, but it copies display lines, which may include display line breaks and message prefixes. Use the copy view when clean source or cross-screen selection is needed.
When there is no valid selection on the regular interface, `Ctrl+C` may still trigger interrupt/exit; do not ask the user to repeatedly press `Ctrl+C` to troubleshoot copy.

Non-fullscreen mode preserves the host terminal's native mouse selection, and the regular interface does not take over the mouse. In this case, first use `F9` or `/copy view` to enter the copy view, then use the mouse inside it; do not promise that bottom-bar clicks work the same in non-fullscreen mode.

The copy view is a bounded preview, not a complete conversation export: it scans at most the most recent 4096 messages, collects up to 512 assistant message snapshots, with a total source text budget of 8 MiB, and at most 1024 answer/code entries combined.
When the preview or parsing budget is reached, handle per the interface prompt; do not describe a successfully copied current entry as the complete history being exported.

### Linux and Terminal Clipboard

- For SSH, prefer OSC 52 to hand the copy request off to the client terminal rather than the server's desktop clipboard.
- Locally, prefer the native clipboard; WSL retains the PowerShell fallback; try OSC 52 only when the native channel is unavailable. Lack of SSH identity does not necessarily mean the terminal clipboard cannot be used.
- The OSC 52 current limit is **100,000 raw UTF-8 bytes**, not character count, and not 100 KiB. Exceeding the limit will error; you can segment-select in the copy view; do not claim to copy arbitrarily long answers.
- "Sent an OSC 52 copy request" is not a client confirmation of success. When the user cannot paste the content, check whether the client allows OSC 52 and the forwarding limits of tmux/screen; do not repeatedly change KCoder configuration or credentials.
- Verifying the copy result should paste into a temporary text location and compare the actual text, newlines, and indentation; do not judge success only by selection highlight or status hints.

## Markdown and Theme

KCoder's base Markdown styling uses Cyan inline code and links, Green blockquotes, and LightBlue ordered numbering; headings are mainly distinguished by bold, underline, and italic, not a colored heading system. Code blocks and table headers use a syntax theme.

In the TUI, use `/theme` to view themes, or use `/theme catppuccin-mocha`, `/theme auto` to switch.
`auto` chooses Catppuccin Mocha dark or Catppuccin Latte light based on the terminal background. `/raw off` turns off raw output mode for the current session; if `render_markdown` itself is `false`, the user-intended setting still needs to be restored.

Current streaming messages do not close the entire Markdown just because they exceed **64 KiB**. Syntax highlighting is limited per **single code block**: when exceeding 512 KiB, 10,000 lines, or any line over 4 KiB, that code block falls back to text without syntax color, and surrounding Markdown is not closed as a result. Unmarked or unrecognized code languages may also have no syntax color.
These byte/line limits are not context token caps, nor existing settings parameters; do not invent "raise streaming Markdown threshold" configuration keys.

For color anomalies, first check `/raw` status, `render_markdown`, `code_theme`, the code language, and the above limits. If a message loses color across the board without exceeding limits, further confirm the build and reproduction conditions; do not directly attribute it to refresh frame rate or ask the user to keep enlarging the context window.

## Truly Configurable Settings

First read the effective value and source:

```bash
kcoder config get render_markdown --source
kcoder config get code_theme --source
kcoder config get tui.alternate_screen --source
```

- `render_markdown`: boolean, default `true`.
- `code_theme`: syntax theme name, default `auto`; available themes are preferably confirmed from the current version's `/theme` selector.
- `tui.alternate_screen`: `auto`, `always`, `never`, default `auto`. The startup argument `--no-alt-screen` is an override for the current process, not a same-name field writable into settings.

Use explicit scopes only when the user requests persisting preferences, e.g.:

```bash
kcoder config set code_theme catppuccin-mocha --scope user
kcoder config validate
```

Seeing a theme switch in the TUI does not equal successful persistence; when persisting is needed, check the save failure hint, the actual source, and new-session results.
Do not create new settings fields for opening F9/F8, changing fixed copy budgets, or solving terminal clipboard permissions.

## Directory Location and Scroll-Back Review

- `F8` or `/outline [query]` opens the conversation outline, locate by task, answer, or title; you can also click outline entries.
- `/jump start` locates the start of the current-turn answer (when there is no current location, uses the most recent turn as the anchor), not the first line of the entire conversation.
- `/jump prev`, `/jump next` switch between previous and next tasks; `/jump latest` returns to the latest output.
- During review, new output should not forcibly pull the user back to the bottom. Directory location in non-fullscreen mode uses the in-app "History" layer, which is not equivalent to the host terminal scrollback.
- F8 is the location outline, F9 is the copy snapshot; we currently cannot promise to copy sections directly within the F8 outline.
- Navigation, highlighting, and copy each have their own resource budgets. A location budget error does not mean history is lost, nor can it be fixed by raising `code_theme` or modifying nonexistent threshold parameters.

If stable skipping lines, blank bands, misalignment, or selection content changes occur, record the build, terminal size, mode, phase, and minimum reproduction. Source fixes should be verified with real terminal behavior; do not use a README update or a single `doctor` success in place of interactive verification.
