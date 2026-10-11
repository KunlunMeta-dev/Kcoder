import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from check_documentation import check, example_errors, link_errors
from generate_references import cli_reference, jsonc, rust_brace_end, schema_rows


class DocumentationContracts(unittest.TestCase):
    def workspace(self):
        temporary = tempfile.TemporaryDirectory(prefix="kcoder-doc-contract-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        return root

    def test_jsonc_preserves_urls_and_comment_looking_strings(self):
        result = jsonc('''{
          // Source comments are not data.
          "url": "https://example.invalid/a/*literal*/",
          "literal": ",] // keep this",
          "array": [true, false,], /* trailing comma */
        }''')
        self.assertEqual(result["url"], "https://example.invalid/a/*literal*/")
        self.assertEqual(result["literal"], ",] // keep this")
        self.assertEqual(result["array"], [True, False])
        with self.assertRaises(ValueError):
            jsonc('{/* unclosed')

    def test_cli_env_file_field_is_not_swallowed_as_an_attribute_continuation(self):
        reference = cli_reference()
        self.assertIn("| `--env-file` |", reference)
        store_row = next(line for line in reference.splitlines() if "| `--store` |" in line)
        self.assertNotIn("env_file: Option", store_row)

    def test_rust_source_braces_ignore_raw_strings_chars_and_nested_comments(self):
        source = '''{ let raw = r##"{ unbalanced"##; let x = '}';
          /* outer { /* nested } */ comment */
          if true { call("}"); }
        } trailing'''
        end = rust_brace_end(source, 0)
        self.assertEqual(source[end:], "} trailing")
        with self.assertRaises(ValueError):
            rust_brace_end('{ let a = "}";', 0)

    def test_recursive_schema_has_bounded_real_field_coverage(self):
        root = {"$defs": {"Node": {"type": "object", "properties": {
            "label": {"type": "string"}, "child": {"$ref": "#/$defs/Node"},
        }}}}
        rows = list(schema_rows(root, {"$ref": "#/$defs/Node"}, "node"))
        self.assertEqual([name for name, _ in rows], ["node", "node.label", "node.child"])

    def test_links_require_existing_targets_anchors_and_repository_boundaries(self):
        root = self.workspace()
        source = root / "source.rs"
        source.write_text("first\nsecond\n")
        doc = root / "README.md"
        doc.write_text('# 内容\n\n[源码](source.rs#L2)\n[标题](#内容)\n')
        self.assertEqual(link_errors(root, doc), [])
        doc.write_text('# 内容\n\n[缺失](missing.md)\n[越界](../outside)\n[行号](source.rs#L9)\n[标题](#missing)\n')
        self.assertEqual(len(link_errors(root, doc)), 4)

    def test_examples_reject_invalid_json_and_unclosed_fences(self):
        root = self.workspace()
        doc = root / "README.md"
        doc.write_text('# 示例\n\n```json\n{"a":1}\n```\n')
        self.assertEqual(example_errors(root, doc), [])
        doc.write_text('# 示例\n\n```json\n"a":1\n```\n```js\nunfinished\n')
        self.assertEqual(len(example_errors(root, doc)), 2)

    def test_coverage_does_not_accept_declared_completion_without_documents(self):
        root = self.workspace()
        (root / "docs").mkdir()
        (root / "new-package").mkdir()
        (root / "new-package/Cargo.toml").write_text('[package]\nname="new"\nversion="1.0.0"\n')
        manifest = {"requiredDocs": ["docs/missing.md"], "generatedReferences": [], "modules": []}
        (root / "docs/coverage.json").write_text(json.dumps(manifest))
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        with contextlib.redirect_stdout(io.StringIO()):
            errors = check(root)
        self.assertIn("Missing required document: docs/missing.md", errors)
        self.assertIn("Uncovered source package: new-package", errors)

    def test_public_snapshot_mode_rejects_accidental_private_docs(self):
        root = self.workspace()
        (root / "README.md").write_text('# KCoder\n')
        self.assertEqual(check(root, public_snapshot=True), [])
        (root / "docs").mkdir()
        self.assertTrue(check(root, public_snapshot=True))


if __name__ == "__main__":
    unittest.main()
