# Upstream source

- Project: https://github.com/larksuite/cli
- Upstream path: `skills/lark-meeting`
- Upstream tag: `v1.0.100`
- Upstream commit: `ac22a60a23d66c37d43a7ec6d9e99b99a4320356` (2026-11-10, "chore: release v1.0.100 (#2910)")
- License: MIT, Copyright (c) 2026 Lark Technologies Pte. Ltd., see [LICENSE](LICENSE).
- Upstream ships no `NOTICE` file.
- The bundled `lark-cli` binary comes from the same release; see `scripts/release/prepare-lark-cli.mjs`.

## KCoder changes relative to that commit

- `SKILL.md` frontmatter: added `metadata.kcoder.references: on_demand` (with a one-line comment) under the upstream `metadata` block. KCoder otherwise inlines every `references/*.md` file when a skill is activated; upstream expects the agent to read individual references when the skill's routing table names them.
- Added `LICENSE`, a verbatim copy of the upstream repository's root `LICENSE`; upstream skill directories carry no license file of their own.
- Added this `UPSTREAM.md`.

All other files are byte-for-byte upstream copies, including any trailing whitespace.

## Notes

- Relative links to sibling skills (for example `../lark-shared/SKILL.md`) resolve because KCoder materializes every bundled skill as a sibling directory.
