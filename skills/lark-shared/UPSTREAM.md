# Upstream source

- Project: https://github.com/larksuite/cli
- Upstream path: `skills/lark-shared`
- Upstream tag: `v1.0.100`
- Upstream commit: `ac22a60a23d66c37d43a7ec6d9e99b99a4320356` (2026-11-10, "chore: release v1.0.100 (#2910)")
- License: MIT, Copyright (c) 2026 Lark Technologies Pte. Ltd., see [LICENSE](LICENSE).
- Upstream ships no `NOTICE` file.
- The bundled `lark-cli` binary comes from the same release; see `scripts/release/prepare-lark-cli.mjs`.

## KCoder changes relative to that commit

- `SKILL.md` frontmatter: added `metadata.kcoder.references: on_demand` (with a one-line comment) under the upstream `metadata` block. KCoder otherwise inlines every `references/*.md` file when a skill is activated; upstream expects the agent to read individual references when the skill's routing table names them.
- `SKILL.md`: added the section "KCoder 运行环境": on the local KCoder Studio target `lark-cli` is bundled and on `PATH`, so neither the CLI nor `npx skills add` is installed; other targets fall back to the upstream `npx @larksuite/cli@latest install`; first use follows the official flow of running `lark-cli config init --new` and `lark-cli auth login --recommend` in the background and forwarding the printed authorization link.
- `references/lark-shared-update-notice.md`: added a KCoder note that the bundled CLI and skills are upgraded with KCoder Studio, so `lark-cli update`, `npm install -g` and `npx skills add` are not run for that copy.
- Added `LICENSE`, a verbatim copy of the upstream repository's root `LICENSE`; upstream skill directories carry no license file of their own.
- Added this `UPSTREAM.md`.

All other files are byte-for-byte upstream copies, including any trailing whitespace.

## Notes

- Relative links to sibling skills (for example `../lark-shared/SKILL.md`) resolve because KCoder materializes every bundled skill as a sibling directory.
