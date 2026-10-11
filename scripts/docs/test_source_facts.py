import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from generate_references import rust_brace_end
from source_facts import claim_errors, declared_integer, integer, profile_layout, tool_profile_facts


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
        for path, value in [("crates/kcoder_tools/src/lib.rs", REGISTRIES),
                            ("crates/kcoder_cli/src/startup/runtime_wiring.rs", WIRING)]:
            file = root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(value)
        _, facts = tool_profile_facts(root, rust_brace_end)
        self.assertEqual(facts["tools.full.wiki_off"], 4)
        self.assertEqual(facts["tools.full.wiki_both"], 6)
        self.assertEqual(facts["tools.none.wiki_both"], 0)
        (root / "crates/kcoder_cli/src/startup/runtime_wiring.rs").write_text(
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
