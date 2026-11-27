"""Derive bounded documentation facts from the current checkout, never user state."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re
import tomllib


REGISTRY_SOURCE = "crates/kcoder_tools/src/lib.rs"
WIRING_SOURCE = "crates/kcoder_cli/src/internal/session_configuration/registry.rs"
FACT_SOURCES = [
    "Cargo.toml", "apps/kcoder-studio/package.json", REGISTRY_SOURCE, WIRING_SOURCE,
    "crates/kcoder_config/src/settings/provider.rs",
    "crates/kcoder_config/src/settings/permissions.rs",
    "crates/kcoder_config/src/settings/knowledge.rs",
    "crates/kcoder_config/src/settings/tools.rs",
    "crates/kcoder_migration/src/history_jobs.rs",
    "crates/kcoder_types/src/workflow.rs", "crates/kcoder_types/src/wiki_pipeline.rs",
    "crates/kcoder_types/src/model_configuration.rs",
    "crates/kcoder_types/src/widgets.rs", "crates/kcoder_types/src/studio_work_mode.rs",
    "crates/kcoder_engine/src/widget_render_verification.rs", "crates/kcoder_engine/src/stream_response.rs",
    "apps/kcoder-studio/desktop/widget-isolation/policy.mjs",
    "crates/kcoder_workflow/src/graph.rs", "crates/kcoder_workflow/src/graph_data.rs",
    "crates/kcoder_knowledge/src/ingest.rs", "crates/kcoder_knowledge/src/archive_segments.rs",
    "crates/kcoder_tools/src/wiki_document.rs", "crates/kcoder_tools/src/image_input.rs",
    "crates/kcoder_tools/src/internal/document_parsers/lib.rs",
]


def rust_code(source):
    """Mask comments and literals without changing byte positions or line breaks."""
    output = list(source)
    index = 0
    while index < len(source):
        start = index
        if source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end < 0 else end
        elif source.startswith("/*", index):
            depth = 1
            index += 2
            while index < len(source) and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ValueError("Unterminated Rust source comment")
        elif raw := re.match(r'(?:br|r)(#{0,255})"', source[index:]):
            end = source.find('"' + raw[1], index + raw.end())
            if end < 0:
                raise ValueError("Unterminated Rust raw literal")
            index = end + 1 + len(raw[1])
        elif char := re.match(r"'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^'\\\n])'", source[index:]):
            index += char.end()
        elif source[index] == '"':
            index += 1
            while index < len(source):
                if source[index] == "\\":
                    index += 2
                elif source[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise ValueError("Unterminated Rust literal")
        else:
            index += 1
            continue
        for position in range(start, min(index, len(source))):
            if source[position] != "\n":
                output[position] = " "
    return "".join(output)


def function_body(source, name, brace_end):
    code = rust_code(source)
    match = re.search(r"\bfn\s+" + re.escape(name) + r"\s*\(", code)
    if not match:
        raise ValueError(f"Missing source function: {name}")
    opening = code.index("{", match.end())
    end = brace_end(source, opening)
    return source[opening + 1:end]


def registrations(body):
    # Constructors in these builders cannot depend on data or arbitrary expressions.
    body = rust_code(body)
    calls = re.findall(r"\.register\(\s*((?:\w+::)*\w+)", body)
    if len(calls) != len(re.findall(r"\.register\s*\(", body)):
        raise ValueError("Unsupported registry constructor")
    return [name.rsplit("::", 1)[-1] for name in calls]


def profile_layout(source, brace_end):
    profiles = {}
    for profile in ("nano", "core", "full"):
        function = "default" if profile == "full" else profile
        body = function_body(source, f"{function}_registry_for_platform", brace_end)
        body = rust_code(body)
        inherited = re.match(r"\s*(\w+)_registry_for_platform\(platform\)", body)
        if inherited:
            parent = inherited[1]
            if parent not in profiles or "match platform" in body:
                raise ValueError(f"Unsupported registry inheritance: {profile}")
            common = profiles[parent]["common"] + registrations(body)
            shells = profiles[parent]["shells"]
            unconditional = body
        else:
            parts = body.split("match platform")
            if len(parts) != 2 or "ToolRegistry::new()" not in parts[0]:
                raise ValueError(f"Unsupported platform registry: {profile}")
            common = registrations(parts[0])
            unconditional = parts[0]
            shells = {}
            for platform, tool in re.findall(
                r"ToolPlatform::(\w+)\s*=>\s*registry\.register\((\w+)\)", parts[1]
            ):
                shells[platform] = tool
            if set(shells) != {"Windows", "UnixLike"} or len(registrations(parts[1])) != 2:
                raise ValueError(f"Unsupported platform branches: {profile}")
        if re.search(r"\b(?:if|match|for|while|loop)\b|cfg!|#\[cfg|\?", unconditional):
            raise ValueError(f"Conditional registry requires explicit activation analysis: {profile}")
        if len(set(common)) != len(common) or set(common) & set(shells.values()):
            raise ValueError(f"Duplicate registry constructors: {profile}")
        profiles[profile] = {"common": common, "shells": shells, "base": len(common) + 1}
    profiles["none"] = {"common": [], "shells": {}, "base": 0}
    return profiles


def tool_profile_facts(root, brace_end):
    profiles = profile_layout((root / REGISTRY_SOURCE).read_text(), brace_end)
    source = (root / WIRING_SOURCE).read_text()
    body = rust_code(function_body(source, "builtin_tools_for_settings", brace_end))
    if "builtin_tools_for_profile" in body:
        if not re.fullmatch(
            r"\s*builtin_tools_for_profile\(\s*cli\.tool_profile\.effective\(settings\.tools\.profile\),\s*settings\s*\)\s*",
            body,
        ):
            raise ValueError("CLI profile delegation changed; review its activation semantics")
        body = rust_code(function_body(source, "builtin_tools_for_profile", brace_end))
    for variant, builder in [("Full", "default"), ("Core", "core"), ("Nano", "nano")]:
        if not re.search(rf"ToolProfile::{variant}\s*=>\s*{builder}_registry\(\)", body):
            raise ValueError(f"CLI profile mapping changed: {variant}")
    if not re.search(r"ToolProfile::None\s*=>\s*return\s+ToolRegistry::new\(\)", body):
        raise ValueError("None profile no longer returns an empty registry")
    additions = registrations(body)
    if additions != ["ConfigTool", "WikiTool", "WikiManageTool"]:
        raise ValueError("CLI tool additions changed; review their activation semantics")
    if not re.search(r"if settings\.knowledge\.can_retrieve\(\)\s*\{\s*tools\.register\(kcoder_tools::wiki::WikiTool\)", body):
        raise ValueError("Wiki retrieval activation changed")
    if not re.search(r"if settings\.knowledge\.can_organize\(\)\s*\{\s*tools\.register\(kcoder_tools::wiki_manage::WikiManageTool\)", body):
        raise ValueError("Wiki organization activation changed")
    facts = {}
    for profile, layout in profiles.items():
        for suffix, extra in [("base", 0), ("wiki_off", 1), ("wiki_one", 2), ("wiki_both", 3)]:
            facts[f"tools.{profile}.{suffix}"] = layout["base"] + (extra if profile != "none" else 0)
    facts["tools.full.range"] = f'{facts["tools.full.wiki_off"]}–{facts["tools.full.wiki_both"]}'
    return profiles, facts


def integer(expression):
    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return node.value
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)):
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            return left * right
        raise ValueError(f"Unsupported integer declaration: {expression}")
    try:
        parsed = ast.parse(expression.strip(), mode="eval")
    except SyntaxError as error:
        raise ValueError(f"Unsupported integer declaration: {expression}") from error
    return evaluate(parsed.body)


RUST_INTEGER_REFERENCES = {
    "kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY":
        ("crates/kcoder_migration/src/history_jobs.rs", "HISTORY_IMPORT_CONCURRENCY"),
}


def declared_integer(root, path, name, _seen=None):
    seen = set() if _seen is None else _seen
    key = (path, name)
    if key in seen or len(seen) >= 8:
        raise ValueError(f"Cyclic integer declaration: {path}:{name}")
    seen = seen | {key}
    source = rust_code((root / path).read_text())
    match = re.search(r"^(?:pub(?:\([^)]*\))?\s+)?const\s+" + re.escape(name) + r"\s*:[^=]+=(.*?);", source, re.M | re.S)
    if not match:
        raise ValueError(f"Missing integer declaration: {path}:{name}")
    expression = match[1]
    # Resolve only explicitly reviewed source constants; never evaluate Rust or Python names.
    for reference, (reference_path, reference_name) in RUST_INTEGER_REFERENCES.items():
        pattern = r"(?<![\w:])" + re.escape(reference) + r"(?![\w:])"
        if re.search(pattern, expression):
            value = declared_integer(root, reference_path, reference_name, seen)
            expression = re.sub(pattern, str(value), expression)
    return integer(expression)


def enum_values(root, path, name, brace_end):
    source = (root / path).read_text()
    match = re.search(r"pub enum " + re.escape(name) + r"\s*\{", source)
    if not match:
        raise ValueError(f"Missing enum: {path}:{name}")
    opening = match.end() - 1
    body = source[opening + 1:brace_end(source, opening)]
    names = re.findall(r"^\s*(\w+),\s*$", body, re.M)
    if not names or re.search(r"#\[serde\(rename\s*=", body):
        raise ValueError(f"Unsupported enum serialization: {name}")
    return [re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower() for value in names]


def widget_facts(root, brace_end):
    """Keep source/UI guarantees distinct; only parse explicit current declarations."""
    facts = {}
    for suffix, constant in [
        ("source_bytes", "WIDGET_SOURCE_BYTES"), ("chunk_bytes", "WIDGET_CHUNK_BYTES"),
        ("session_bytes", "WIDGET_SESSION_BYTES"), ("revisions", "WIDGET_REVISION_LIMIT"),
        ("turn_records", "WIDGET_TURN_LIMIT"),
    ]:
        facts[f"widget.{suffix}"] = declared_integer(root, "crates/kcoder_types/src/widgets.rs", constant)
    for key, path, name in [
        ("studio.work_modes", "crates/kcoder_types/src/studio_work_mode.rs", "StudioWorkMode"),
        ("widget.formats", "crates/kcoder_types/src/widgets.rs", "WidgetFormat"),
        ("widget.execution_modes", "crates/kcoder_types/src/widgets.rs", "WidgetExecutionMode"),
        ("widget.libraries", "crates/kcoder_types/src/widgets.rs", "WidgetLibrary"),
    ]:
        facts[key] = enum_values(root, path, name, brace_end)
    verification = rust_code((root / "crates/kcoder_engine/src/widget_render_verification.rs").read_text())
    stream = rust_code((root / "crates/kcoder_engine/src/stream_response.rs").read_text())
    for key, source, pattern in [
        ("widget.feedback_seconds", verification, r"timeout\(Duration::from_secs\((\d+)\),\s*wait\)"),
        ("widget.automatic_repairs", stream, r"let\s+mut\s+widget_render_repairs_remaining\s*=\s*(\d+)u8\s*;"),
    ]:
        matches = re.findall(pattern, source)
        if len(matches) != 1:
            raise ValueError(f"Unsupported widget declaration: {key}")
        facts[key] = int(matches[0])
    native = (root / "apps/kcoder-studio/desktop/widget-isolation/policy.mjs").read_text()
    versions = re.findall(r"if \(electronVersion !== '([^']+)' \|\| !chromiumVersion\.startsWith\('(\d+)\.'\)\)", native)
    if len(versions) != 1:
        raise ValueError("Unsupported native widget runtime admission guard")
    facts["widget.native_electron"], facts["widget.native_chromium_major"] = versions[0]
    return facts


def luna_default_facts(root, brace_end):
    body = function_body((root / "crates/kcoder_config/src/settings/tools.rs").read_text(), "default_luna_allowed_tools", brace_end)
    if not re.search(r'let shell = if cfg!\(windows\) \{ "PowerShell" \} else \{ "bash" \};', body):
        raise ValueError("Unsupported Luna platform-shell selection")
    array = re.search(r"\[([\s\S]*?)\]\s*\.into_iter\(\)", body)
    if not array:
        raise ValueError("Missing Luna default allowlist")
    tools = []
    for line in array[1].splitlines():
        entry = line.strip().removesuffix(",")
        if not entry:
            continue
        tool = "bash/PowerShell" if entry == "shell" else json.loads(entry)
        if not isinstance(tool, str) or not tool or tool in tools:
            raise ValueError("Unsupported or duplicate Luna default tool")
        tools.append(tool)
    return {"tools.luna.default": tools, "tools.luna.default.count": len(tools)}


def manifest_package_version(manifest, workspace_version):
    """Keep explicit product versions separate from inherited library versions."""
    version = manifest.get("package", {}).get("version")
    if isinstance(version, str) and version:
        return version
    if isinstance(version, dict) and version.keys() == {"workspace"} and version["workspace"] is True:
        return workspace_version
    raise ValueError("Unsupported Cargo package version declaration")


def source_facts(root, brace_end):
    _, facts = tool_profile_facts(root, brace_end)
    facts.update(widget_facts(root, brace_end))
    facts.update(luna_default_facts(root, brace_end))
    cargo = tomllib.loads((root / "Cargo.toml").read_text())
    facts["version.workspace"] = cargo["workspace"]["package"]["version"]
    cli_cargo = tomllib.loads((root / "crates/kcoder_cli/Cargo.toml").read_text())
    facts["version.cli"] = manifest_package_version(cli_cargo, facts["version.workspace"])
    facts["version.studio"] = json.loads((root / "apps/kcoder-studio/package.json").read_text())["version"]
    members = set()
    excluded = set(cargo["workspace"].get("exclude", []))
    for pattern in cargo["workspace"]["members"]:
        for directory in root.glob(pattern):
            if (directory / "Cargo.toml").is_file() and directory.relative_to(root).as_posix() not in excluded:
                members.add(directory.relative_to(root).as_posix())
    product = sorted(tomllib.loads((root / member / "Cargo.toml").read_text())["package"]["name"]
                     for member in members if member.startswith("crates/"))
    facts.update({"crates.product.names": product, "crates.product.count": len(product), "crates.workspace.count": len(members)})
    for key, path, name in [
        ("api.formats", "crates/kcoder_config/src/settings/provider.rs", "ApiFormat"),
        ("permission.modes", "crates/kcoder_config/src/settings/permissions.rs", "PermissionMode"),
        ("workflow.kinds", "crates/kcoder_types/src/workflow.rs", "WorkflowNodeKind"),
        ("wiki.stages", "crates/kcoder_types/src/wiki_pipeline.rs", "WikiPipelineStageKind"),
        ("wiki.statuses", "crates/kcoder_types/src/wiki_pipeline.rs", "WikiPipelineStageStatus"),
    ]:
        values = enum_values(root, path, name, brace_end)
        facts[key] = values
        facts[key + ".count"] = len(values)
    for key, path, constant in [
        ("migration.history_observation_queue", "crates/kcoder_cli/src/app_server/migration_processor/observations.rs", "MAX_HISTORY_OBSERVATIONS"),
        ("migration.history_active_observations", "crates/kcoder_cli/src/app_server/migration_processor/observations.rs", "ACTIVE_HISTORY_OBSERVATIONS"),
        ("migration.tool_attachment_items", "crates/kcoder_migration/src/history_tool_attachments.rs", "MAX_TOOL_ATTACHMENTS"),
        ("migration.context_default_bytes", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_DEFAULT_BYTES"),
        ("migration.context_max_bytes", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_MAX_BYTES"),
        ("migration.context_default_entries", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_DEFAULT_ENTRIES"),
        ("migration.context_max_entries", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_MAX_ENTRIES"),
        ("migration.context_default_attachments", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_DEFAULT_ATTACHMENTS"),
        ("migration.context_default_attachment_bytes", "crates/kcoder_types/src/historical_context.rs", "HISTORICAL_CONTEXT_DEFAULT_ATTACHMENT_BYTES"),
        ("migration.context_preparations", "crates/kcoder_state/src/historical_contexts.rs", "MAX_CONTEXT_PREPARATIONS"),
        ("migration.context_preparation_bytes", "crates/kcoder_state/src/historical_contexts.rs", "MAX_CONTEXT_PREPARATION_BYTES"),
        ("migration.continuation_jobs", "crates/kcoder_migration/src/history_continuation_jobs.rs", "MAX_CONTINUATION_JOBS"),
        ("migration.continuation_metadata", "crates/kcoder_migration/src/history_continuation_jobs.rs", "META"),
        ("migration.historical_seed_bytes", "crates/kcoder_state/src/historical_seed.rs", "MAX_HISTORICAL_SEED_BYTES"),
        ("migration.attachment_directories", "crates/kcoder_state/src/external_history/attachments.rs", "MAX_BLOBS"),
        ("migration.attachment_total_bytes", "crates/kcoder_state/src/external_history/attachments.rs", "TOTAL_BYTES"),
        ("migration.attachment_bytes", "crates/kcoder_types/src/historical_attachment.rs", "HISTORICAL_ATTACHMENT_MAX_BYTES"),
        ("migration.attachment_chunk_bytes", "crates/kcoder_types/src/historical_attachment.rs", "HISTORICAL_ATTACHMENT_CHUNK_BYTES"),
        ("migration.attachment_jobs", "crates/kcoder_migration/src/history_attachment_jobs.rs", "MAX_JOBS"),
        ("migration.attachment_job_metadata", "crates/kcoder_migration/src/history_attachment_jobs.rs", "META"),
        ("migration.local_upload_part_bytes", "crates/kcoder_types/src/local_attachment_upload.rs", "HISTORICAL_LOCAL_UPLOAD_PART_BYTES"),
        ("migration.local_upload_bytes", "crates/kcoder_types/src/local_attachment_upload.rs", "HISTORICAL_LOCAL_UPLOAD_MAX_BYTES"),
        ("migration.local_upload_staging_bytes", "crates/kcoder_types/src/local_attachment_upload.rs", "HISTORICAL_LOCAL_UPLOAD_MAX_STAGING_BYTES"),
        ("model.output_tokens", "crates/kcoder_types/src/model_configuration.rs", "DEFAULT_MODEL_OUTPUT_TOKENS"),
        ("workflow.max_nodes", "crates/kcoder_workflow/src/graph.rs", "MAX_NODES"),
        ("workflow.definition_bytes", "crates/kcoder_workflow/src/graph.rs", "MAX_DEFINITION_BYTES"),
        ("workflow.args_bytes", "crates/kcoder_workflow/src/graph.rs", "MAX_ARGS_BYTES"),
        ("workflow.value_bytes", "crates/kcoder_workflow/src/graph_data.rs", "MAX_VALUE_BYTES"),
        ("workflow.schema_bytes", "crates/kcoder_workflow/src/graph_data.rs", "MAX_SCHEMA_BYTES"),
        ("wiki.output_tokens", "crates/kcoder_knowledge/src/ingest.rs", "WIKI_MAX_OUTPUT_TOKENS"),
        ("wiki.response_bytes", "crates/kcoder_knowledge/src/ingest.rs", "WIKI_MAX_OUTPUT_BYTES"),
        ("wiki.page_bytes", "crates/kcoder_knowledge/src/ingest.rs", "WIKI_MAX_PAGE_BYTES"),
        ("wiki.proposal_bytes", "crates/kcoder_knowledge/src/ingest.rs", "WIKI_MAX_PROPOSAL_BYTES"),
        ("wiki.document_bytes", "crates/kcoder_tools/src/wiki_document.rs", "MAX_DOCUMENT_BYTES"),
        ("wiki.extracted_bytes", "crates/kcoder_tools/src/internal/document_parsers/lib.rs", "MAX_EXTRACTED_BYTES"),
        ("wiki.chunk_bytes", "crates/kcoder_tools/src/wiki_document.rs", "MAX_CHUNK_BYTES"),
        ("wiki.max_chunks", "crates/kcoder_tools/src/wiki_document.rs", "MAX_DOCUMENT_CHUNKS"),
        ("wiki.image_bytes", "crates/kcoder_tools/src/image_input.rs", "MAX_BYTES"),
        ("wiki.image_edge", "crates/kcoder_tools/src/image_input.rs", "MAX_EDGE"),
        ("wiki.image_small_edge", "crates/kcoder_tools/src/image_input.rs", "SMALL_EDGE"),
        ("wiki.archive_bytes", "crates/kcoder_knowledge/src/archive_segments.rs", "MAX_COLLECTION_BYTES"),
        ("wiki.segment_bytes", "crates/kcoder_knowledge/src/archive_segments.rs", "MAX_ARCHIVE_SEGMENT_BYTES"),
        ("wiki.max_segments", "crates/kcoder_knowledge/src/archive_segments.rs", "MAX_SEGMENTS"),
    ]:
        facts[key] = declared_integer(root, path, constant)
    facts["workflow.agent_turns"] = integer(function_body(
        (root / "crates/kcoder_types/src/workflow.rs").read_text(), "default_max_turns", brace_end
    ))
    return facts


def claim_errors(root, brace_end):
    try:
        manifest = json.loads((root / "docs/source-claims.json").read_text())
        facts = source_facts(root, brace_end)
    except (OSError, ValueError, KeyError) as error:
        return [f"Cannot verify source-backed documentation claims: {error}"]
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("claims"), list):
        return ["Invalid source-claim inventory"]
    errors = []
    for claim in manifest["claims"]:
        try:
            name, fact = claim["path"], claim["fact"]
            file = root / name
            if Path(name).is_absolute() or not file.resolve().is_relative_to(root.resolve()):
                raise ValueError("claim path escapes repository")
            if file.suffix != ".md" and name != "site/index.html":
                raise ValueError("claim target is not a maintained document")
            matches = list(re.finditer(claim["pattern"], file.read_text(), re.M))
            if len(matches) != 1:
                raise ValueError(f"expected one claim location, received {len(matches)}")
            actual = matches[0].group("value")
            expected = facts[fact]
            if isinstance(expected, list):
                observed = re.findall(claim.get("items", r"`([^`]+)`"), actual)
                if sorted(observed) != sorted(expected):
                    raise ValueError(f"documented {observed}, source declares {expected}")
            else:
                divisor = claim.get("divisor", 1)
                if divisor != 1:
                    if type(expected) is not int or type(divisor) is not int or divisor <= 0 or expected % divisor:
                        raise ValueError("invalid claim unit conversion")
                    expected //= divisor
                if actual.replace(",", "") != str(expected):
                    raise ValueError(f"documented {actual}, source declares {expected}")
        except (OSError, ValueError, KeyError, TypeError, re.error) as error:
            errors.append(f"Source-claim drift: {claim!r}: {error}")
    return errors
