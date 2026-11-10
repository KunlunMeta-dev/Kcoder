import json
from pathlib import Path
import tempfile
from textwrap import dedent
import unittest
from unittest.mock import patch

from generate_references import rust_brace_end
from source_facts import (
    REGISTRY_SOURCE, WIRING_SOURCE, claim_errors, declared_integer, integer,
    manifest_package_version, profile_layout, tool_profile_facts, widget_facts, luna_default_facts,
)


REGISTRIES = """
fn nano_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    let registry = ToolRegistry::new().register(ReadTool);
    match platform {
        ToolPlatform::Windows => registry.register(PowerShellTool),
        ToolPlatform::UnixLike => registry.register(BashTool),
    }
}
fn core_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    nano_registry_for_platform(platform).register(AgentTool)
}
fn default_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    let registry = ToolRegistry::new().register(ReadTool).register(WriteTool);
    match platform {
        ToolPlatform::Windows => registry.register(PowerShellTool),
        ToolPlatform::UnixLike => registry.register(BashTool),
    }
}
"""
WIRING = """
fn builtin_tools_for_settings(cli: &Cli, settings: &Settings) -> ToolRegistry {
    let tools = match profile {
        ToolProfile::Full => default_registry(),
        ToolProfile::Core => core_registry(),
        ToolProfile::Nano => nano_registry(),
        ToolProfile::None => return ToolRegistry::new(),
    };
    let tools = tools.register(ConfigTool);
    let tools = if settings.knowledge.can_retrieve() {
        tools.register(kcoder_tools::wiki::WikiTool)
    } else { tools };
    if settings.knowledge.can_organize() {
        tools.register(kcoder_tools::wiki_manage::WikiManageTool)
    } else { tools }
}
"""


class SourceFactContracts(unittest.TestCase):
    def test_product_version_does_not_silently_use_workspace_library_version(self):
        self.assertEqual(manifest_package_version({"package": {"version": "2.0.0"}}, "0.1.0"), "2.0.0")
        self.assertEqual(manifest_package_version({"package": {"version": {"workspace": True}}}, "0.1.0"), "0.1.0")
        for invalid in [None, 2, {"workspace": False}, {"workspace": 1}, {}]:
            with self.subTest(version=invalid), self.assertRaises(ValueError):
                manifest_package_version({"package": {"version": invalid}}, "0.1.0")

    def workspace(self):
        temporary = tempfile.TemporaryDirectory(prefix="kcoder-source-facts-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "docs").mkdir()
        return root

    def test_inheritance_counts_one_platform_shell_not_both(self):
        profiles = profile_layout(REGISTRIES, rust_brace_end)
        self.assertEqual(profiles["nano"]["base"], 2)
        self.assertEqual(profiles["core"]["base"], 3)
        self.assertEqual(profiles["full"]["base"], 3)

    def test_cli_additions_have_separate_wiki_gates_and_none_stays_empty(self):
        root = self.workspace()
        for path, value in [(REGISTRY_SOURCE, REGISTRIES),
                            (WIRING_SOURCE, WIRING)]:
            file = root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(value)
        _, facts = tool_profile_facts(root, rust_brace_end)
        self.assertEqual(facts["tools.full.wiki_off"], 4)
        self.assertEqual(facts["tools.full.wiki_both"], 6)
        self.assertEqual(facts["tools.none.wiki_both"], 0)
        (root / WIRING_SOURCE).write_text(
            WIRING.replace("can_retrieve()", "can_organize()")
        )
        with self.assertRaisesRegex(ValueError, "retrieval activation"):
            tool_profile_facts(root, rust_brace_end)

    def test_unknown_platforms_duplicates_and_conditional_calls_fail_closed(self):
        for source in [REGISTRIES.replace("Windows =>", "Other =>"),
                       REGISTRIES.replace(".register(WriteTool)", ".register(ReadTool)"),
                       REGISTRIES.replace("let registry =", 'if condition { register(); } let registry =', 1)]:
            with self.assertRaises(ValueError):
                profile_layout(source, rust_brace_end)

    def test_profile_helper_preserves_cli_precedence_and_rejects_changed_delegation(self):
        root = self.workspace()
        registry = root / REGISTRY_SOURCE
        registry.parent.mkdir(parents=True)
        registry.write_text(REGISTRIES)
        wiring = root / WIRING_SOURCE
        wiring.parent.mkdir(parents=True)
        helper = WIRING.replace("builtin_tools_for_settings(cli: &Cli, settings: &Settings)",
                                "builtin_tools_for_profile(profile: ToolProfile, settings: &Settings)")
        wrapper = """fn builtin_tools_for_settings(cli: &Cli, settings: &Settings) -> ToolRegistry {
            builtin_tools_for_profile(cli.tool_profile.effective(settings.tools.profile), settings)
        }\n"""
        wiring.write_text(wrapper + helper)
        _, facts = tool_profile_facts(root, rust_brace_end)
        self.assertEqual(facts["tools.full.wiki_both"], 6)
        wiring.write_text(wrapper.replace("cli.tool_profile.effective(settings.tools.profile)",
                                         "settings.tools.profile") + helper)
        with self.assertRaisesRegex(ValueError, "profile delegation"):
            tool_profile_facts(root, rust_brace_end)

    def test_comments_raw_literals_and_escaped_strings_do_not_create_registrations(self):
        source = REGISTRIES.replace("let registry =", '''
            // .register(CommentTool)
            /* nested /* .register(NestedTool) */ comment */
            let raw = r##".register(RawTool) fn fake() {"##;
            let text = "escaped \\" .register(TextTool)";
            let registry =''', 1)
        profiles = profile_layout(source, rust_brace_end)
        self.assertEqual(profiles["nano"]["base"], 2)

    def test_integer_parser_does_not_execute_code(self):
        self.assertEqual(integer("4 * 1024 * 1024"), 4194304)
        self.assertEqual(integer("262_144"), 262144)
        for expression in ["True", "2 ** 3", "open('secret').read()", "return 60"]:
            with self.assertRaises(ValueError):
                integer(expression)

    def test_private_crate_and_public_constants_share_the_same_numeric_contract(self):
        root = self.workspace()
        file = root / "limits.rs"
        file.write_text('pub(crate) const PRIVATE: usize = 8 * 1024;\npub const PUBLIC: usize = 16;\nconst LOCAL: u64 = 32;\n')
        self.assertEqual(declared_integer(root, "limits.rs", "PRIVATE"), 8192)
        self.assertEqual(declared_integer(root, "limits.rs", "PUBLIC"), 16)
        self.assertEqual(declared_integer(root, "limits.rs", "LOCAL"), 32)

    def test_commented_and_quoted_constants_cannot_override_real_numeric_limits(self):
        root = self.workspace()
        (root / "limits.rs").write_text(dedent('''
            /* pub const LIMIT: usize = 999; */
            const EXAMPLE: &str = r##"pub const LIMIT: usize = 998;"##;
            // pub const LIMIT: usize = 997;
            pub const LIMIT: usize = 32 * 1024;
        '''))
        self.assertEqual(declared_integer(root, "limits.rs", "LIMIT"), 32768)

    def test_reviewed_cross_crate_integer_reference_tracks_changes_and_rejects_unknown_or_cycles(self):
        root = self.workspace()
        shared = root / "crates/kcoder_migration/src/history_jobs.rs"
        shared.parent.mkdir(parents=True)
        shared.write_text("pub const HISTORY_IMPORT_CONCURRENCY: usize = 32;")
        declaration = root / "limits.rs"
        expression = "kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY"
        declaration.write_text(f"const LIMIT: usize = 2 * {expression};")
        self.assertEqual(declared_integer(root, "limits.rs", "LIMIT"), 64)
        shared.write_text("pub const HISTORY_IMPORT_CONCURRENCY: usize = 40;")
        self.assertEqual(declared_integer(root, "limits.rs", "LIMIT"), 80)
        declaration.write_text(f"const LIMIT: usize = 2 * {expression}_UNKNOWN;")
        with self.assertRaisesRegex(ValueError, "Unsupported integer declaration"):
            declared_integer(root, "limits.rs", "LIMIT")
        declaration.write_text(f"const LIMIT: usize = {expression};")
        shared.write_text(f"pub const HISTORY_IMPORT_CONCURRENCY: usize = {expression};")
        with self.assertRaisesRegex(ValueError, "Cyclic integer declaration"):
            declared_integer(root, "limits.rs", "LIMIT")

    def widget_workspace(self):
        root = self.workspace()
        repository = Path(__file__).resolve().parents[2]
        for path in ["crates/kcoder_types/src/widgets.rs", "crates/kcoder_types/src/studio_work_mode.rs",
                     "crates/kcoder_engine/src/widget_render_verification.rs", "crates/kcoder_engine/src/stream_response.rs",
                     "apps/kcoder-studio/desktop/widget-isolation/policy.mjs"]:
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text((repository / path).read_text())
        return root

    def test_widget_claims_follow_limits_modes_and_changed_feedback_deadlines(self):
        root = self.widget_workspace()
        facts = widget_facts(root, rust_brace_end)
        self.assertEqual(facts["studio.work_modes"], ["kcoder", "kworker"])
        self.assertEqual(facts["widget.source_bytes"], 1024 * 1024)
        self.assertEqual(facts["widget.chunk_bytes"], 32 * 1024)
        self.assertEqual(facts["widget.feedback_seconds"], 3)
        self.assertEqual(facts["widget.automatic_repairs"], 2)
        source = root / "crates/kcoder_engine/src/widget_render_verification.rs"
        source.write_text(source.read_text().replace("Duration::from_secs(3)", "Duration::from_secs(4)"))
        self.assertEqual(widget_facts(root, rust_brace_end)["widget.feedback_seconds"], 4)

    def test_widget_unknown_runtime_guard_and_nonliteral_limits_fail_for_review(self):
        root = self.widget_workspace()
        policy = root / "apps/kcoder-studio/desktop/widget-isolation/policy.mjs"
        original = policy.read_text()
        policy.write_text(original.replace("chromiumVersion.startsWith('148.')", "chromiumVersion.startsWith(allowedChromium)"))
        with self.assertRaisesRegex(ValueError, "runtime admission guard"):
            widget_facts(root, rust_brace_end)
        policy.write_text(original)
        limits = root / "crates/kcoder_types/src/widgets.rs"
        limits.write_text(limits.read_text().replace("WIDGET_SOURCE_BYTES: usize = 1024 * 1024", "WIDGET_SOURCE_BYTES: usize = read_private_configuration()"))
        with self.assertRaisesRegex(ValueError, "Unsupported integer declaration"):
            widget_facts(root, rust_brace_end)

    def test_luna_platform_shell_counts_once_and_unknown_entries_fail_for_review(self):
        root = self.workspace()
        file = root / "crates/kcoder_config/src/settings/tools.rs"
        file.parent.mkdir(parents=True)
        source = '''pub(crate) fn default_luna_allowed_tools() -> Vec<String> {
            let shell = if cfg!(windows) { "PowerShell" } else { "bash" };
            [
                "read",
                shell,
                "Workflow",
                "TodoWrite",
            ].into_iter().map(str::to_string).collect()
        }'''
        file.write_text(source)
        facts = luna_default_facts(root, rust_brace_end)
        self.assertEqual(facts["tools.luna.default.count"], 4)
        self.assertEqual(facts["tools.luna.default"], ["read", "bash/PowerShell", "Workflow", "TodoWrite"])
        file.write_text(source.replace('"read",', '"read",\n"read",'))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            luna_default_facts(root, rust_brace_end)
        file.write_text(source.replace('"read",', 'external_default(),'))
        with self.assertRaises(ValueError):
            luna_default_facts(root, rust_brace_end)

    def claims(self, root, claims):
        (root / "docs/source-claims.json").write_text(json.dumps({"schemaVersion": 1, "claims": claims}))

    def test_wrong_numbers_and_wrong_units_are_rejected(self):
        root = self.workspace()
        (root / "README.md").write_text("Tools: 64\nBytes: 4 MiB\n")
        claims = [{"path": "README.md", "fact": "count", "pattern": r"Tools: (?P<value>\d+)"},
                  {"path": "README.md", "fact": "bytes", "divisor": 1048576,
                   "pattern": r"Bytes: (?P<value>\d+) MiB"}]
        self.claims(root, claims)
        with patch("source_facts.source_facts", return_value={"count": 67, "bytes": 4194304}):
            errors = claim_errors(root, rust_brace_end)
        self.assertEqual(len(errors), 1)
        self.assertIn("documented 64, source declares 67", errors[0])

    def test_enum_missing_extra_and_duplicate_rows_are_rejected(self):
        root = self.workspace()
        self.claims(root, [{"path": "README.md", "fact": "kinds", "pattern": r"(?P<value>[\s\S]+)"}])
        for text in ["`a`", "`a` `b` `extra`", "`a` `b` `b`"]:
            (root / "README.md").write_text(text)
            with patch("source_facts.source_facts", return_value={"kinds": ["a", "b"]}):
                self.assertTrue(claim_errors(root, rust_brace_end))

    def test_missing_and_ambiguous_claims_and_private_files_are_rejected(self):
        root = self.workspace()
        (root / "README.md").write_text("Tools: 67\nTools: 67\n")
        self.claims(root, [
            {"path": "README.md", "fact": "count", "pattern": r"Tools: (?P<value>\d+)"},
            {"path": "README.md", "fact": "count", "pattern": r"Missing: (?P<value>\d+)"},
            {"path": ".env", "fact": "count", "pattern": r"(?P<value>.*)"},
            {"path": "../outside.md", "fact": "count", "pattern": r"(?P<value>.*)"},
        ])
        with patch("source_facts.source_facts", return_value={"count": 67}):
            self.assertEqual(len(claim_errors(root, rust_brace_end)), 4)


if __name__ == "__main__":
    unittest.main()
