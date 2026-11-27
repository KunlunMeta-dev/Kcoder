# Upstream source

- Project: https://github.com/anthropics/skills
- Upstream path: `skills/docx`
- Upstream commit: `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (2026-11-16, "Update docx, pptx and xlsx skills: zipfile unpack, zip -y, validate.py and soffice.py fixes (#2221)")
- License: Apache License 2.0, see [LICENSE.txt](LICENSE.txt). Upstream relicensed this skill from its former proprietary terms in commit `2c5958ecac7cee2b583967a2c4981d0f4a75c579` ("Move Office skills to the Apache 2.0 license (#2146)").
- Upstream ships no `NOTICE` file for this skill.

## KCoder changes relative to that commit

- `scripts/accept_changes.py`: KCoder failure contract. Each run uses a private LibreOffice profile and a staged copy in a temporary directory beside the output instead of the shared `/tmp/libreoffice_docx_profile`. The output is published with an atomic replace only after LibreOffice succeeds and the result is verified to be an intact DOCX with no pending tracked-change elements. Timeouts, LibreOffice failures and invalid output are reported as errors and publish nothing; upstream reports a timeout as success. The file carries a modification notice.
- `scripts/comment.py`: the default comment author is `KCoder` instead of `Claude`, in both the function signature and the `--author` CLI default. The file carries a modification notice.
- `SKILL.md`: the **Read** row points to KCoder's `read` tool for paragraphs and tables first, and keeps `pandoc` for headings, lists, comments and tracked changes.
- `SKILL.md`: the `docx` dependency notes say KCoder provides `docx` and `node` in the local Studio target, that `require` (not `import`) resolves it, and that other targets install it when `require('docx')` fails; upstream calls it preinstalled.
- All files are shipped with mode `0644`. KCoder bundles skill resources without executable bits; upstream marks some scripts executable.
- Added this `UPSTREAM.md`.
