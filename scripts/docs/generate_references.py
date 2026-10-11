#!/usr/bin/env python3
"""Generate source-linked documentation without loading credentials or runtimes."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import re

from source_facts import REGISTRY_SOURCE, WIRING_SOURCE, tool_profile_facts


ROOT = Path(__file__).resolve().parents[2]


def jsonc(text: str):
    """Remove comments and trailing commas only outside JSON strings."""
    output = []
    index = 0
    quoted = False
    while index < len(text):
        char = text[index]
        if quoted:
            output.append(char)
            if char == "\\":
                index += 1
                if index < len(text):
                    output.append(text[index])
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end
            continue
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise ValueError("Unterminated JSONC comment")
            output.append(" ")
            index = end + 2
            continue
        else:
            output.append(char)
        index += 1
    plain = "".join(output)
    output = []
    quoted = False
    index = 0
    while index < len(plain):
        char = plain[index]
        if quoted:
            output.append(char)
            if char == "\\":
                index += 1
                if index < len(plain):
                    output.append(plain[index])
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif char == ",":
            following = index + 1
            while following < len(plain) and plain[following].isspace():
                following += 1
            if following >= len(plain) or plain[following] not in "}]":
                output.append(char)
        else:
            output.append(char)
        index += 1
    return json.loads("".join(output))


def escape(value) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", "")


def source_link(path: str, line: int | None = None, depth: int = 2) -> str:
    suffix = f"#L{line}" if line else ""
    return f"[{path}]({'../' * depth}{path}{suffix})"


def header(title: str, sources: list[str], depth: int = 2) -> str:
    digest = hashlib.sha256()
    for source in sources:
        digest.update(source.encode() + b"\0" + (ROOT / source).read_bytes())
    return (
        f"# {title}\n\n"
        "以下内容由源码声明生成；使用方式与状态边界见对应专题指南。"
        "源码声明、编译条件与运行时可用性需要分别判断。\n\n"
        f"来源指纹：`{digest.hexdigest()}`。更新命令："
        "`python3 scripts/docs/generate_references.py`。\n\n"
        "来源：" + "、".join(source_link(p, depth=depth) for p in sources) + "。\n\n"
    )


def resolve_schema(root, value):
    reference = value.get("$ref")
    if reference and reference.startswith("#/"):
        target = root
        for key in reference[2:].split("/"):
            target = target[key.replace("~1", "/").replace("~0", "~")]
        return {**target, **{k: v for k, v in value.items() if k != "$ref"}}
    return value


def schema_rows(root, node, prefix="", references=()):
    if not isinstance(node, dict):
        return
    reference = node.get("$ref")
    recursive = bool(reference and reference in references)
    value = resolve_schema(root, node)
    if prefix:
        yield prefix, value
    if recursive:
        return
    next_references = (*references, reference) if reference else references
    for key, child in value.get("properties", {}).items():
        yield from schema_rows(root, child, f"{prefix}.{key}".lstrip("."), next_references)
    dynamic = value.get("additionalProperties")
    if isinstance(dynamic, dict):
        yield from schema_rows(root, dynamic, f"{prefix}.*", next_references)
    items = value.get("items")
    if isinstance(items, dict):
        yield from schema_rows(root, items, f"{prefix}[]", next_references)
    for variant in value.get("oneOf", []) + value.get("anyOf", []) + value.get("allOf", []):
        yield from schema_rows(root, variant, prefix, next_references)


def settings_reference():
    source = "crates/kcoder_config/settings.schema.jsonc"
    schema = jsonc((ROOT / source).read_text())
    lines = [header("配置字段参考", [source]),
             "`*` 表示用户定义的键，`[]` 表示数组项。默认值列是 schema 的声明值；"
             "首次安装的嵌入配置、已有用户设置、项目 overlay 和 CLI 参数可能不同。"
             "实际请求以目标端合并后的模型快照为准。\n\n"]
    for key, node in schema.get("properties", {}).items():
        lines += [f"## {key}\n\n", "| 字段 | 类型或约束 | Schema 默认值 | 源码说明 |\n",
                  "| --- | --- | --- | --- |\n"]
        seen = set()
        for path, value in schema_rows(schema, node, key):
            kind = value.get("type", "组合或引用")
            if "enum" in value:
                kind = json.dumps(value["enum"], ensure_ascii=False)
            constraints = {k: value[k] for k in ("minimum", "maximum", "minItems", "maxItems", "pattern") if k in value}
            if constraints:
                kind = f"{kind}; {json.dumps(constraints, ensure_ascii=False)}"
            default = json.dumps(value["default"], ensure_ascii=False) if "default" in value else "未声明"
            description = value.get("description", value.get("title", ""))
            row = (path, str(kind), default, description)
            if row in seen:
                continue
            seen.add(row)
            lines.append(f"| `{escape(path)}` | {escape(kind)} | `{escape(default)}` | {escape(description)} |\n")
        lines.append("\n")
    return "".join(lines)


def rpc_reference():
    source = "crates/kcoder_app_protocol/src/lib.rs"
    text = (ROOT / source).read_text()
    start = text.index("pub mod method {")
    end = text.index("\n}\n", start)
    declarations = list(re.finditer(r'pub const (\w+): &str\s*=\s*"([^"]+)";', text[start:end]))
    lines = [header("app-server 方法参考", [source]),
             "本表同时包含请求和事件通知。请求需要 id、initialize 和正确的所有者上下文；"
             "方法名称出现在协议里不表示所有客户端、平台或能力组合都能调用。"
             "参数/响应类型见协议 crate 的对应领域文件与生成的共享合同。\n\n",
             "| 常量 | 线协议方法 | 声明 |\n", "| --- | --- | --- |\n"]
    for match in declarations:
        line = text.count("\n", 0, start + match.start()) + 1
        lines.append(f"| `{match[1]}` | `{match[2]}` | {source_link(source, line)} |\n")
    lines += ["\n## 领域类型\n\n", "| 文件 | 公开类型 |\n", "| --- | --- |\n"]
    for file in sorted((ROOT / "crates/kcoder_app_protocol/src").glob("*.rs")):
        if file.name == "tests.rs":
            continue
        names = re.findall(r"^pub\s+(?:struct|enum|type)\s+(\w+)", file.read_text(), re.M)
        if names:
            lines.append(f"| {source_link(str(file.relative_to(ROOT)))} | " + "、".join(f"`{n}`" for n in names) + " |\n")
    return "".join(lines)


def cli_reference():
    source = "crates/kcoder_cli/src/cli_args.rs"
    text = (ROOT / source).read_text()
    lines = [header("CLI 参数参考", [source]),
             "名称由 clap 声明派生。这里保留源码中的英文参数说明；中文使用流程见 CLI 与 TUI 指南。"
             "不要把内部 worker 参数作为普通用户入口。\n\n"]
    current = ""
    comments = []
    attributes = []
    in_attribute = False
    for number, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        declaration = re.search(r"pub\(super\) (?:struct|enum) (\w+)", raw)
        if declaration:
            current = declaration[1]
            lines += [f"\n## {current}\n\n", "| 声明 | 参数或值 | 属性 | 说明 |\n", "| --- | --- | --- | --- |\n"]
            comments, attributes = [], []
            in_attribute = False
        elif stripped.startswith("///"):
            comments.append(stripped[3:].strip())
        elif stripped.startswith("#[") or in_attribute:
            attributes.append(stripped)
            in_attribute = not stripped.endswith("]")
        elif current:
            field = re.match(r"(?:pub\(super\)\s+)?([a-z_]\w*):\s*(.+),", stripped)
            variant = re.match(r"([A-Z]\w*)\s*(?:\{|,)", stripped)
            if field or variant:
                name = field[1] if field else variant[1]
                attrs = " ".join(attributes)
                if field:
                    long = re.search(r'long\s*=\s*"([^"]+)"', attrs)
                    display = "--" + (long[1] if long else name.replace("_", "-")) if "long" in attrs else name
                else:
                    display = re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()
                lines.append(f"| {source_link(source, number)} | `{display}` | `{escape(attrs)}` | {escape(' '.join(comments))} |\n")
                comments, attributes = [], []
            elif stripped and not stripped.startswith(("#[", "//")):
                comments, attributes = [], []
    return "".join(lines)


def tool_reference():
    files = sorted((ROOT / "crates/kcoder_tools/src").rglob("*.rs"))
    sources = [str(p.relative_to(ROOT)) for p in files if "impl Tool for" in p.read_text() and "tests" not in p.parts and not p.name.endswith("_tests.rs")]
    lines = [header("内置工具源码参考", sources),
             "本表索引源码中显式声明的 Tool 实现及附近的输入类型。宏生成、MCP、插件和宿主注入的工具还需检查注册器；"
             "实际工具清单和参数 schema 以本轮 tools/catalog 与角色注册表为准。"
             "只读与并发是调用策略，不根据名称或 schema 外观推断。\n\n",
             "这里还包含未直接注册的内部 stage 适配器，不能按本表行数统计会话工具。"
             "基础注册表、CLI 追加与 Wiki 开关的数量见 [配置档统计](tool-profiles.md)。\n\n",
             "| Tool 实现 | 输入类型声明 | 源码 |\n", "| --- | --- | --- |\n"]
    count = 0
    for source in sources:
        text = (ROOT / source).read_text()
        if "#[cfg(test)]" in text:
            text = text[:text.index("#[cfg(test)]")]
        inputs = re.findall(r"pub (?:struct|enum) (\w*Input\w*)", text)
        for match in re.finditer(r"impl Tool for ([A-Za-z_][A-Za-z0-9_]*)", text):
            line = text.count("\n", 0, match.start()) + 1
            lines.append(f"| `{match[1]}` | " + "、".join(f"`{n}`" for n in inputs) + f" | {source_link(source, line)} |\n")
            count += 1
    if not count:
        raise ValueError("No tool declarations found")
    return "".join(lines)


def tool_profiles_reference():
    profiles, facts = tool_profile_facts(ROOT, rust_brace_end)
    sources = [REGISTRY_SOURCE, WIRING_SOURCE, "crates/kcoder_config/src/settings/knowledge.rs"]
    lines = [header("内置工具配置档与注册数量", sources),
             "统计对象是普通 CLI/app-server 的内置注册器，含平台 Shell，"
             "不含动态 MCP、插件、桌面工具、验证器和编排角色的专用追加/过滤。"
             "Windows 注册 PowerShell，UnixLike 注册 bash，二者不会同时计入。\n\n",
             "| 配置档 | Tools 基础注册表 | CLI：Wiki 均关闭 | CLI：只开一项 Wiki | CLI：Wiki 两项都开启 |\n",
             "| --- | --- | --- | --- | --- |\n"]
    for profile in ("full", "core", "nano", "none"):
        values = [facts[f"tools.{profile}.{suffix}"] for suffix in ("base", "wiki_off", "wiki_one", "wiki_both")]
        lines.append(f"| `{profile}` | " + " | ".join(str(value) for value in values) + " |\n")
    lines += ["\n普通非 none 配置档追加 Config；retrieval_enabled 允许检索时追加 Wiki，"
              "organization_enabled 允许整理时追加 WikiManage。单项开关缺省继承旧 enabled；"
              "默认 Wiki 关闭。none 提前返回空注册器，不因 Wiki 开启而追加工具。\n\n",
              "注册数量不等于发给模型的数量：Engine 还按目标工具能力、Goal、用户问询权限、"
              "文件修改界面、编排角色及终态验证器请求过滤。tools/catalog 应指定当前 threadId；"
              "未指定时返回 workspace 视图。检查 total/truncated；冻结请求的暴露数量以实际"
              "模型快照为准，不用当前 catalog 替代历史请求。\n\n",
              "## 基础注册类型\n\n",
              "此表按类型列出基础注册链，公开工具名称仍以实际 Tool.name 和运行时目录为准。\n\n",
              "| Tool 类型 | full | core | nano |\n", "| --- | --- | --- | --- |\n"]
    common = set().union(*(set(value["common"]) for value in profiles.values()))
    for name in sorted(common):
        marks = ["✓" if name in profiles[profile]["common"] else "—" for profile in ("full", "core", "nano")]
        lines.append(f"| `{name}` | " + " | ".join(marks) + " |\n")
    lines.append("| `bash` / `PowerShell`（按平台选一） | ✓ | ✓ | ✓ |\n")
    return "".join(lines)


def rust_brace_end(text, start):
    """Balance source braces while ignoring comments, chars and string literals."""
    depth = 0
    index = start
    while index < len(text):
        if text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end
            continue
        if text.startswith("/*", index):
            nesting = 1
            index += 2
            while index < len(text) and nesting:
                if text.startswith("/*", index):
                    nesting += 1
                    index += 2
                elif text.startswith("*/", index):
                    nesting -= 1
                    index += 2
                else:
                    index += 1
            continue
        raw = re.match(r'(?:br|r)(#{0,255})"', text[index:])
        if raw:
            end = text.find('"' + raw[1], index + raw.end())
            if end < 0:
                raise ValueError("Unterminated Rust raw string")
            index = end + 1 + len(raw[1])
            continue
        char = re.match(r"'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^'\\\n])'", text[index:])
        if char:
            index += char.end()
            continue
        if text[index] == '"':
            index += 1
            while index < len(text):
                if text[index] == "\\":
                    index += 2
                elif text[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            continue
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("Unclosed Rust declaration")


def type_reference(files, title, depth=2):
    sources = [str(p.relative_to(ROOT)) for p in files]
    lines = [header(title, sources, depth),
             "字段列保留 Rust 声明名、类型和 serde 属性。线协议名称还需服从 type 上的 rename_all、"
             "字段 rename/flatten/tag 与序列化实现；不从 Option 或 pub 单独推断 JSON 必填性。\n\n"]
    for file in files:
        text = file.read_text()
        for match in re.finditer(r"^pub (struct|enum) (\w+)[^;{]*\{", text, re.M):
            opening = match.end() - 1
            end = rust_brace_end(text, opening)
            body = text[opening + 1:end]
            if match[1] == "struct":
                fields = list(re.finditer(r"\bpub (\w+)\s*:\s*", body))
                if not fields:
                    continue
            else:
                fields = list(re.finditer(r"^    (\w+)\s*(?:[,{(]|$)", body, re.M))
                if not fields:
                    continue
            line = text.count("\n", 0, match.start()) + 1
            prefix = text[max(0, text.rfind("\n\n", 0, match.start())):match.start()]
            attrs = " ".join(re.findall(r"#\[serde\((.*?)\)\]", prefix, re.S))
            lines += [f"## {match[2]}\n\n", source_link(str(file.relative_to(ROOT)), line, depth) + "。",
                      f"序列化属性：`{escape(attrs)}`。\n\n" if attrs else "\n\n",
                      "| Rust 字段或 variant | 类型或内容 | 字段属性 |\n", "| --- | --- | --- |\n"]
            previous = 0
            for field in fields:
                before = body[previous:field.start()]
                attributes = " ".join(re.findall(r"#\[serde\((.*?)\)\]", before, re.S))
                following = field.end()
                angle = square = parentheses = braces = 0
                while following < len(body):
                    char = body[following]
                    if char == "," and not (angle or square or parentheses or braces):
                        break
                    if char == "<": angle += 1
                    elif char == ">": angle = max(0, angle - 1)
                    elif char == "[": square += 1
                    elif char == "]": square = max(0, square - 1)
                    elif char == "(": parentheses += 1
                    elif char == ")": parentheses = max(0, parentheses - 1)
                    elif char == "{": braces += 1
                    elif char == "}": braces = max(0, braces - 1)
                    following += 1
                value = re.sub(r"\s+", " ", body[field.end():following].strip())
                if match[1] == "enum":
                    value = "见源码 variant 定义"
                lines.append(f"| `{field[1]}` | `{escape(value)}` | `{escape(attributes)}` |\n")
                previous = following + 1
            lines.append("\n")
    return "".join(lines)


def protocol_types():
    files = sorted((ROOT / "crates/kcoder_app_protocol/src").glob("*.rs"))
    output = {}
    index = ["# 协议参数与响应类型\n\n", "这些类型按协议源码领域分组，字段、serde 属性与来源行由生成器维护。"
             "使用方法与请求/通知边界见 [协议](../protocol.md)。\n\n",
             "| 领域 | 类型声明 |\n", "| --- | --- |\n"]
    for file in files:
        if file.name == "tests.rs":
            continue
        names = re.findall(r"^pub (?:struct|enum) (\w+)", file.read_text(), re.M)
        if not names:
            continue
        path = f"docs/reference/protocol/{file.stem}.md"
        output[path] = type_reference([file], file.stem + " 协议类型", depth=3)
        index.append(f"| [{file.stem}](protocol/{file.stem}.md) | " + "、".join(f"`{n}`" for n in names) + " |\n")
    output["docs/reference/protocol-types.md"] = "".join(index)
    return output


def tool_inputs():
    files = sorted((ROOT / "crates/kcoder_tools/src").glob("*.rs"))
    selected = [p for p in files if re.search(r"^pub struct \w*Input\w*", p.read_text(), re.M)]
    return type_reference(selected, "工具输入与公开数据类型")


def integer_expression(value):
    def resolve(node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Mult, ast.Add, ast.Sub)):
            left, right = resolve(node.left), resolve(node.right)
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Add): return left + right
            return left - right
        raise ValueError("Non-literal source limit")
    return resolve(ast.parse(value, mode="eval").body)


def limits_reference():
    sources = [
        "crates/kcoder_workflow/src/graph.rs", "crates/kcoder_workflow/src/graph_data.rs",
        "crates/kcoder_knowledge/src/ingest.rs", "crates/kcoder_tools/src/wiki_document.rs",
        "crates/kcoder_tools/src/image_input.rs", "crates/kcoder_cli/src/app_server/protocol_io.rs",
        "crates/kcoder_computer_use/src/policy.rs", "crates/kcoder_computer_use/src/framing.rs",
    ]
    lines = [header("资源与额度声明", sources),
             "字节、像素、节点数量与 token 是不同单位。下表保存 source 常量表达式和可安全解析的整数值；"
             "服务上限、配置覆盖和调用时条件仍需对应运行时校验。\n\n",
             "| 常量 | 源码表达式 | 整数值 | 来源 |\n", "| --- | --- | --- | --- |\n"]
    for source in sources:
        text = (ROOT / source).read_text()
        for match in re.finditer(r"(?:pub(?:\([^)]*\))? )?const ((?:MAX_|WIKI_|SMALL_)[A-Z0-9_]+): (?:u\d+|usize) = ([^;]+);", text):
            try:
                numeric = str(integer_expression(match[2]))
            except (ValueError, SyntaxError):
                numeric = "由引用或运行时确定"
            line = text.count("\n", 0, match.start()) + 1
            lines.append(f"| `{match[1]}` | `{escape(match[2])}` | {numeric} | {source_link(source, line)} |\n")
    return "".join(lines)


def hook_reference():
    source = "crates/kcoder_hooks/src/types.rs"
    text = (ROOT / source).read_text()
    opening = text.index("{", text.index("pub enum HookEvent"))
    end = rust_brace_end(text, opening)
    variants = re.findall(r"^    (\w+),", text[opening:end], re.M)
    lines = [header("Hook 事件声明", [source]),
             "枚举声明不保证所有变体都有实际触发入口。配置解析接受多个命名形式；"
             "使用前按事件检查宿主/Engine 的 emitter 和验证。\n\n",
             "| Rust 事件 | Serde 名称 |\n", "| --- | --- |\n"]
    for variant in variants:
        snake = re.sub(r"(?<!^)(?=[A-Z])", "_", variant).lower()
        lines.append(f"| `{variant}` | `{snake}` |\n")
    return "".join(lines)


def generated_files():
    files = {
        "docs/reference/settings.md": settings_reference(),
        "docs/reference/rpc-methods.md": rpc_reference(),
        "docs/reference/cli.md": cli_reference(),
        "docs/reference/tools.md": tool_reference(),
        "docs/reference/tool-profiles.md": tool_profiles_reference(),
        "docs/reference/tool-inputs.md": tool_inputs(),
        "docs/reference/resource-limits.md": limits_reference(),
        "docs/reference/hook-events.md": hook_reference(),
        **protocol_types(),
    }
    return {name: text.rstrip() + "\n" for name, text in files.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    failures = []
    for name, expected in generated_files().items():
        file = ROOT / name
        if args.check:
            if not file.exists() or file.read_text() != expected:
                failures.append(name)
        else:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(expected)
    if failures:
        print("Documentation references need regeneration: " + ", ".join(failures))
        return 1
    print("Documentation references: " + ("checked" if args.check else "generated"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
