#!/usr/bin/env python3
"""Reject Han characters in source comments and external-product attribution language."""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys


HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
RUST_RAW_STRING = re.compile(r"(?:br|rb|r)(#{0,255})\"")
C_LIKE = {
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".rs",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsonc",
    ".css",
    ".scss",
}
HASH_COMMENT = {
    ".py",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".toml",
    ".yaml",
    ".yml",
    ".conf",
    ".service",
    ".env",
    ".example",
    ".npmignore",
}
HASH_COMMENT_NAMES = {
    ".dockerignore",
    ".gitattributes",
    ".gitignore",
    ".npmignore",
    ".prettierignore",
}
SEMICOLON_COMMENT = {".nsi", ".nsh"}
HTML_COMMENT = {".html", ".htm", ".svg", ".xml", ".plist", ".md"}
ATTRIBUTION_MARKERS = (
    "\u501f\u9274",
    "\u5bf9\u6807",
    "\u4eff\u7167",
    "\u53c2\u8003\u5b9e\u73b0",
    "inspired " + "by",
    "modeled " + "after",
    "modeled " + "on",
    "borrowed " + "from",
    "borrowing " + "from",
    "reference " + "implementation",
    "adapted " + "from",
    "codex-" + "style",
    "codex " + "style",
    "opencode " + "style",
)
PRODUCT_ATTRIBUTION = re.compile(
    r"""
    (?:\b(?:(?:adapted|borrowed|borrowing|ported|copied|copying|derived|taken|lifted|cloned)\s+from|based\s+on)\b[^\n.]{0,100}\b(?:codex|claude(?:\s+code)?|kimi(?:\s+cli)?|reef|opencode|copilot(?:\s+cli)?|codewhale)\b)
    |(?:\b(?:inspired|modelled|modeled)\s+(?:by|after|on)\b[^\n.]{0,100}\b(?:codex|claude(?:\s+code)?|kimi(?:\s+cli)?|reef|opencode|copilot(?:\s+cli)?|codewhale)\b)
    |(?:(?<![a-z0-9])(?:mirrors?|follows?|matches?|aligned[-_\s]+with|parity[-_\s]+with|reference[-_\s]+baseline|(?:more[-_\s]+)?like|(?:smaller|larger|better|worse)[-_\s]+than)[-_\s:]+[^\n.]{0,80}(?<![a-z0-9])(?:codex|claude(?:[-_\s]+code)?|kimi(?:[-_\s]+cli)?|reef|opencode|copilot(?:[-_\s]+cli)?|codewhale)(?:'s)?(?![a-z0-9]))
    |(?:(?<![a-z0-9])(?:codex|claude|kimi|reef|opencode|copilot|codewhale)(?:'s)?[-_\s]+(?:style|styles|approach|design|implementation|presentation|shape|semantics|boundary|inspired|derived|based|layout|palette|colors|wrapper|heuristics|defaults|policy|suffixes|encoding|markers|surface|interaction|footer)(?![a-z0-9]))
    |(?:(?:\u53c2\u8003|\u501f\u9274|\u5bf9\u6807|\u4eff\u7167|\u6a21\u4eff|\u770b\u9f50|\u79fb\u690d\u81ea|\u6e90\u81ea)[^\n]{0,100}(?:codex|claude|kimi|reef|opencode|copilot|codewhale))
    |(?:(?:codex|claude|kimi|reef|opencode|copilot|codewhale)[^\n]{0,100}(?:\u53c2\u8003|\u501f\u9274|\u5bf9\u6807|\u4eff\u7167|\u6a21\u4eff|\u770b\u9f50|\u79fb\u690d\u81ea|\u6e90\u81ea))
    """,
    re.IGNORECASE | re.VERBOSE,
)
IGNORED_ATTRIBUTION_PARTS = (
    "/third_party/",
    "/node_modules/",
    "/target/",
    "/scripts/audit/audit_source_language.py",
)
ENGLISH_RUNTIME_FILES = {
    "crates/kcoder_engine/src/prompt_runtime.rs",
    "crates/kcoder_engine/src/moa_plan.rs",
    "crates/kcoder_cli/src/cli_args.rs",
    "crates/kcoder_cli/src/app_server.rs",
}
ENGLISH_RUNTIME_PREFIXES = ("crates/kcoder_repl/src/slash/",)
ENGLISH_RUNTIME_FILES.add(
    "apps/kcoder-studio/mobile/src/components/composer-slash.ts"
)
SLASH_LOCALE_FILE = "apps/kcoder-studio/renderer/src/i18n/locales/zh-CN/common.json"
SLASH_LOCALE_KEYS = {
    "goal_pro_input_placeholder",
    "loading_slash_command_skills",
    "no_slash_commands",
    "slash_command_arguments_not_supported",
    "slash_command_goal",
    "slash_command_goal_description",
    "slash_command_goal_pro_description",
    "slash_command_group_actions",
    "slash_command_group_skills",
    "slash_command_menu_title",
    "slash_command_model",
    "slash_command_model_description",
    "slash_command_plan",
    "slash_command_plan_description",
    "slash_command_required",
    "slash_command_skills_error",
    "slash_command_ultgoal_description",
    "slash_command_unknown",
    "slash_command_unknown_or_incomplete",
    "ultgoal_input_placeholder",
}


def tracked_files(root: pathlib.Path) -> list[pathlib.Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [root / pathlib.Path(raw.decode()) for raw in result.stdout.split(b"\0") if raw]


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def c_like_comments(text: str):
    index = 0
    length = len(text)
    while index < length:
        raw = RUST_RAW_STRING.match(text, index)
        if raw:
            closing = '"' + raw.group(1)
            index = raw.end()
            end = text.find(closing, index)
            index = length if end < 0 else end + len(closing)
            continue
        char = text[index]
        if char in ('"', "'", "`"):
            quote = char
            index += 1
            while index < length:
                if text[index] == "\\":
                    index += 2
                elif text[index] == quote:
                    index += 1
                    break
                else:
                    index += 1
            continue
        if text.startswith("//", index):
            end = text.find("\n", index + 2)
            end = length if end < 0 else end
            yield index, text[index:end]
            index = end
            continue
        if text.startswith("/*", index):
            start = index
            index += 2
            depth = 1
            while index < length and depth:
                if text.startswith("/*", index):
                    depth += 1
                    index += 2
                elif text.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            yield start, text[start:index]
            continue
        index += 1


def line_comments(text: str, marker: str):
    offset = 0
    for line in text.splitlines(keepends=True):
        quote = None
        escaped = False
        for index, char in enumerate(line):
            if escaped:
                escaped = False
                continue
            if char == "\\" and quote == '"':
                escaped = True
                continue
            if char in ("'", '"'):
                quote = None if quote == char else char if quote is None else quote
                continue
            if char == marker and quote is None:
                yield offset + index, line[index:].rstrip("\r\n")
                break
        offset += len(line)


def html_comments(text: str):
    for match in re.finditer(r"<!--[\s\S]*?-->", text):
        yield match.start(), match.group(0)


def powershell_comments(text: str):
    yield from line_comments(text, "#")
    for match in re.finditer(r"<#[\s\S]*?#>", text):
        yield match.start(), match.group(0)


def comment_failures(path: pathlib.Path, text: str):
    suffix = path.suffix.lower()
    name = path.name.lower()
    if suffix in C_LIKE:
        comments = c_like_comments(text)
    elif suffix == ".ps1":
        comments = powershell_comments(text)
    elif suffix in HASH_COMMENT or name in HASH_COMMENT_NAMES or text.startswith("#!"):
        comments = line_comments(text, "#")
    elif suffix in SEMICOLON_COMMENT:
        comments = line_comments(text, ";")
    elif suffix in HTML_COMMENT:
        comments = html_comments(text)
    elif suffix == ".in" and "<!--" in text:
        comments = html_comments(text)
    elif suffix == ".in":
        comments = line_comments(text, "#")
    else:
        return
    for offset, comment in comments:
        if HAN.search(comment):
            yield line_number(text, offset), comment.splitlines()[0][:160]


def main() -> int:
    if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1] in {"-h", "--help"}):
        print("Usage: scripts/audit/audit_source_language.py [REPOSITORY_ROOT]")
        return 0 if len(sys.argv) == 2 else 2
    root = pathlib.Path(sys.argv[1] if len(sys.argv) == 2 else pathlib.Path(__file__).parents[2]).resolve()
    failures: list[str] = []
    for path in tracked_files(root):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        relative = path.relative_to(root).as_posix()
        if (
            relative in ENGLISH_RUNTIME_FILES
            or relative.startswith(ENGLISH_RUNTIME_PREFIXES)
        ) and HAN.search(text):
            failures.append(f"{relative}: model or user-facing runtime text must be English")
        if HAN.search(text):
            for line, preview in comment_failures(path, text) or ():
                failures.append(f"{relative}:{line}: non-English source comment: {preview}")
        if relative == SLASH_LOCALE_FILE:
            try:
                locale = json.loads(text)
                workbench = locale.get("workbench", {})
            except (json.JSONDecodeError, AttributeError):
                failures.append(f"{relative}: slash-command locale must be valid JSON")
            else:
                for key in sorted(SLASH_LOCALE_KEYS):
                    value = workbench.get(key)
                    if not isinstance(value, str) or HAN.search(value):
                        failures.append(
                            f"{relative}: workbench.{key} must be present and English"
                        )
        normalized = f"/{relative.lower()}"
        if not any(part in normalized for part in IGNORED_ATTRIBUTION_PARTS):
            lowered = text.lower()
            for marker in ATTRIBUTION_MARKERS:
                if marker.lower() in lowered:
                    failures.append(f"{relative}: external-product attribution wording: {marker}")
            if match := PRODUCT_ATTRIBUTION.search(text):
                preview = " ".join(match.group(0).split())[:160]
                failures.append(
                    f"{relative}: external-product attribution wording: {preview}"
                )
    if failures:
        print("FAIL: source-language audit found violations:")
        print("\n".join(failures))
        return 1
    print("OK: source comments are English and no external-product attribution wording was found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
