# llm_wiki prompt excerpts

Source: llm_wiki, commit `48fd970e206a02a6d2028d1dbfc41b7a0345bf0b`, `src/lib/ingest.ts`.
Copyright (C) 2024-2026 Yong Su. These prompt excerpts retain the upstream GPLv3 license included in LICENSE; they are not relicensed as MIT.

- analysis.md: literal analysis instructions from buildAnalysisPrompt; KCoder supplies language, library purpose, bounded source material, and retrieved page context separately. Upstream schema.md and full index interpolation are not currently injected into the runtime prompt.
- merge.md: content-preservation rules from buildPageMergeSystemPrompt; upstream file-output framing is omitted. The prohibition on describing old/new versions is omitted because KCoder must preserve actual source version distinctions.
- KCoder uses typed JSON page proposals instead of upstream FILE blocks. No upstream runtime or model transport is bundled here.

Upstream ingest.ts SHA256: `7d0fda5ace6bec0c0bd7f25a7c01ab4a89d3b2605910d28853f6d49d535eeb22`.
