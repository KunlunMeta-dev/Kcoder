use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::visit::Visit;
use syn::{
    Attribute, File, ForeignItem, ImplItem, Item, ItemMacro, ItemMod, LitStr, Meta, Token,
    TraitItem, Visibility,
};

fn workspace_root() -> PathBuf {
    PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
}

const ROOT_FRAGMENTS: &[&str] = &[
    "usage.rs",
    "moa.rs",
    "moa_plan.rs",
    "tool_logging.rs",
    "todo.rs",
    "tool_definitions.rs",
    "shell_policy.rs",
    "tool_profiles.rs",
    "skill_curator.rs",
    "goal_budget.rs",
    "usage_response.rs",
    "turn_duration.rs",
    "arrangement.rs",
    "client_persistence.rs",
    "lifecycle_config.rs",
    "stream_protocol.rs",
    "memory_observation.rs",
    "provider_runtime.rs",
    "shell_execution.rs",
    "tool_execution.rs",
    "skill_activation.rs",
    "tool_errors.rs",
    "message_repair.rs",
    "prompt_context.rs",
    "checkpoint_permissions.rs",
    "diagnostic_runtime.rs",
];

const ROOT_FRAGMENT_OWNED_MODULES: &[&str] = &[
    "client_session_runtime.rs",
    "memory_recording_runtime.rs",
    "permission_runtime.rs",
    "provider_runtime.rs",
    "tool_file_observation.rs",
    "tool_failure_runtime.rs",
    "todo_runtime.rs",
    "skill_maintenance_runtime.rs",
];

const RUNTIME_UNITS: &[(&str, &str)] = &[
    ("tool_schema_runtime.rs", "tool_schema_runtime_unit.rs"),
    ("background_runtime.rs", "background_runtime_unit.rs"),
    ("compaction_runtime.rs", "compaction_runtime_unit.rs"),
    ("forking.rs", "forking_unit.rs"),
    ("lifecycle.rs", "lifecycle_unit.rs"),
    ("memory_observer.rs", "memory_observer_unit.rs"),
    (
        "session_memory_runtime.rs",
        "session_memory_runtime_unit.rs",
    ),
    ("moa_runtime.rs", "moa_internal_failure.rs"),
];

const MODULE_LOCAL_UNITS: &[(&str, &str)] = &[
    ("context/compact.rs", "compact/tests.rs"),
    ("background.rs", "background/tests.rs"),
    ("agent.rs", "agent/tests.rs"),
    ("session_end_runtime.rs", "session_end_runtime/tests.rs"),
    ("summary_runtime.rs", "summary_runtime/tests.rs"),
    ("tool_repair.rs", "tool_repair/tests.rs"),
    ("tdd_guard.rs", "tdd_guard/tests.rs"),
];

const MODULE_LOCAL_PRODUCTION_MODULES: &[(&str, &str, &str)] = &[
    (
        "agent.rs",
        "context_projection",
        "agent/context_projection.rs",
    ),
    ("agent.rs", "tool_policy", "agent/tool_policy.rs"),
    (
        "agent.rs",
        "artifact_validation",
        "agent/artifact_validation.rs",
    ),
    (
        "context/compact.rs",
        "history",
        "context/compact/history.rs",
    ),
    (
        "context/compact.rs",
        "protocol",
        "context/compact/protocol.rs",
    ),
    ("context/compact.rs", "usage", "context/compact/usage.rs"),
    ("background.rs", "publisher", "background/publisher.rs"),
    ("background.rs", "spawner", "background/spawner.rs"),
    (
        "memory_observer.rs",
        "diagnostics",
        "memory_observer/diagnostics.rs",
    ),
    (
        "memory_observer.rs",
        "model_codec",
        "memory_observer/model_codec.rs",
    ),
    (
        "tool_repair.rs",
        "sanitization",
        "tool_repair/sanitization.rs",
    ),
    ("tool_repair.rs", "ranking", "tool_repair/ranking.rs"),
    ("tool_repair.rs", "storage", "tool_repair/storage.rs"),
];

const MODULE_LOCAL_TEST_INCLUDE_FRAGMENTS: &[(&str, &str, &str)] = &[
    (
        "tool_repair/tests.rs",
        "tests/sanitization.rs",
        "tool_repair/tests/sanitization.rs",
    ),
    (
        "tool_repair/tests.rs",
        "tests/ranking.rs",
        "tool_repair/tests/ranking.rs",
    ),
    (
        "tool_repair/tests.rs",
        "tests/recording.rs",
        "tool_repair/tests/recording.rs",
    ),
    (
        "tool_repair/tests.rs",
        "tests/storage.rs",
        "tool_repair/tests/storage.rs",
    ),
];

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct PathModuleReference {
    source: PathBuf,
    path: String,
    module: String,
}

fn source_root() -> PathBuf {
    workspace_root().join("crates/kcoder_engine/src")
}

fn read(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    fs::read_to_string(path).unwrap_or_else(|error| panic!("读取 {} 失败: {error}", path.display()))
}

fn parse_source(path: impl AsRef<Path>) -> File {
    let path = path.as_ref();
    syn::parse_file(&read(path))
        .unwrap_or_else(|error| panic!("解析 {} 的 Rust AST 失败: {error}", path.display()))
}

fn rust_sources_below(root: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, sources: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, sources);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push(path);
            }
        }
    }

    let mut sources = Vec::new();
    visit(root, &mut sources);
    sources.sort();
    sources
}

fn rust_inventory(root: &Path) -> BTreeSet<PathBuf> {
    rust_sources_below(root)
        .into_iter()
        .map(|path| path.strip_prefix(root).unwrap().to_path_buf())
        .collect()
}

fn validate_rust_inventory(
    root: &Path,
    expected: &BTreeSet<PathBuf>,
) -> Result<(), (BTreeSet<PathBuf>, BTreeSet<PathBuf>)> {
    let actual = rust_inventory(root);
    let missing: BTreeSet<PathBuf> = expected.difference(&actual).cloned().collect();
    let orphaned: BTreeSet<PathBuf> = actual.difference(expected).cloned().collect();
    if missing.is_empty() && orphaned.is_empty() {
        Ok(())
    } else {
        Err((missing, orphaned))
    }
}

fn validate_module_local_test_inventory(
    source_root: &Path,
    units: &[(&str, &str)],
    production_modules: &[(&str, &str, &str)],
    include_fragments: &[(&str, &str, &str)],
) -> Result<(), (BTreeSet<PathBuf>, BTreeSet<PathBuf>)> {
    let mut expected = units
        .iter()
        .map(|(module, unit)| {
            Path::new(module)
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join(unit)
        })
        .collect::<BTreeSet<_>>();
    expected.extend(
        production_modules
            .iter()
            .map(|(_, _, target)| PathBuf::from(target)),
    );
    expected.extend(
        include_fragments
            .iter()
            .map(|(_, _, target)| PathBuf::from(target)),
    );
    let owned_directories = expected
        .iter()
        .map(|path| path.parent().unwrap().to_path_buf())
        .collect::<BTreeSet<_>>();
    let actual = rust_sources_below(source_root)
        .into_iter()
        .map(|path| path.strip_prefix(source_root).unwrap().to_path_buf())
        .filter(|path| {
            owned_directories
                .iter()
                .any(|directory| path.starts_with(directory))
        })
        .collect::<BTreeSet<_>>();
    let missing: BTreeSet<PathBuf> = expected.difference(&actual).cloned().collect();
    let orphaned: BTreeSet<PathBuf> = actual.difference(&expected).cloned().collect();
    if missing.is_empty() && orphaned.is_empty() {
        Ok(())
    } else {
        Err((missing, orphaned))
    }
}

fn attribute_path_is(attribute: &Attribute, segments: &[&str]) -> bool {
    let path = attribute.path();
    path.segments.len() == segments.len()
        && path
            .segments
            .iter()
            .zip(segments)
            .all(|(segment, expected)| segment.ident == *expected)
}

fn has_test_attribute(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute_path_is(attribute, &["test"])
            || attribute_path_is(attribute, &["tokio", "test"])
            || attribute_generates_test_marker(attribute)
    })
}

fn meta_is_test_marker(meta: &Meta) -> bool {
    let path = match meta {
        Meta::Path(path) => path,
        Meta::List(list) => &list.path,
        Meta::NameValue(name_value) => &name_value.path,
    };
    (path.segments.len() == 1 && path.is_ident("test"))
        || (path.segments.len() == 2
            && path.segments[0].ident == "tokio"
            && path.segments[1].ident == "test")
}

fn meta_generates_test_marker(meta: &Meta) -> bool {
    if meta_is_test_marker(meta) {
        return true;
    }
    let Meta::List(list) = meta else {
        return false;
    };
    list.path.is_ident("cfg_attr")
        && Punctuated::<Meta, Token![,]>::parse_terminated
            .parse2(list.tokens.clone())
            .is_ok_and(|nested| nested.iter().skip(1).any(meta_generates_test_marker))
}

fn attribute_generates_test_marker(attribute: &Attribute) -> bool {
    let Meta::List(list) = &attribute.meta else {
        return false;
    };
    list.path.is_ident("cfg_attr")
        && Punctuated::<Meta, Token![,]>::parse_terminated
            .parse2(list.tokens.clone())
            .is_ok_and(|nested| nested.iter().skip(1).any(meta_generates_test_marker))
}

// Treat only positive-polarity `test` conditions as enabling test mode. Each nested
// `not` flips polarity, so `cfg(not(test))` is not reported while `cfg(not(not(test)))` is recognized.
fn meta_contains_positive_test(meta: &Meta, negated: bool) -> bool {
    match meta {
        Meta::Path(path) => path.is_ident("test") && !negated,
        Meta::List(list) => {
            let Ok(nested) =
                Punctuated::<Meta, Token![,]>::parse_terminated.parse2(list.tokens.clone())
            else {
                return false;
            };
            let nested_negated = negated ^ list.path.is_ident("not");
            nested
                .iter()
                .any(|meta| meta_contains_positive_test(meta, nested_negated))
        }
        Meta::NameValue(_) => false,
    }
}

fn meta_enables_test_condition(meta: &Meta) -> bool {
    let Meta::List(list) = meta else {
        return false;
    };
    let Ok(nested) = Punctuated::<Meta, Token![,]>::parse_terminated.parse2(list.tokens.clone())
    else {
        return false;
    };
    if list.path.is_ident("cfg") {
        return nested
            .iter()
            .any(|meta| meta_contains_positive_test(meta, false));
    }
    list.path.is_ident("cfg_attr") && nested.iter().skip(1).any(meta_enables_test_condition)
}

fn attribute_enables_test(attribute: &Attribute) -> bool {
    meta_enables_test_condition(&attribute.meta)
}

fn exact_cfg_test_attribute(attribute: &Attribute) -> bool {
    let Meta::List(list) = &attribute.meta else {
        return false;
    };
    if !list.path.is_ident("cfg") {
        return false;
    }
    Punctuated::<Meta, Token![,]>::parse_terminated
        .parse2(list.tokens.clone())
        .is_ok_and(|nested| {
            nested.len() == 1
                && matches!(nested.first(), Some(Meta::Path(path)) if path.is_ident("test"))
        })
}

fn path_attribute_value(attributes: &[Attribute]) -> Result<Option<String>, String> {
    let path_attributes = attributes
        .iter()
        .filter(|attribute| attribute.path().is_ident("path"))
        .collect::<Vec<_>>();
    if path_attributes.len() > 1 {
        return Err("mod 包含重复 #[path] 属性".to_string());
    }
    let Some(attribute) = path_attributes.first() else {
        return Ok(None);
    };
    let Meta::NameValue(name_value) = &attribute.meta else {
        return Err("#[path] 必须是 name-value 属性".to_string());
    };
    let syn::Expr::Lit(expression) = &name_value.value else {
        return Err("#[path] 值必须是字符串字面量".to_string());
    };
    let syn::Lit::Str(value) = &expression.lit else {
        return Err("#[path] 值必须是字符串字面量".to_string());
    };
    Ok(Some(value.value()))
}

fn assert_external_test_module(item: &Item, expected_path: &str, expected_module: &str) {
    let Item::Mod(module) = item else {
        panic!("预期外置测试 mod {expected_module}");
    };
    assert_eq!(module.ident, expected_module);
    assert!(matches!(module.vis, Visibility::Inherited));
    assert!(module.content.is_none(), "测试 mod 必须通过 #[path] 外置");
    assert!(module.semi.is_some(), "外置测试 mod 必须以分号结束");
    assert_eq!(
        path_attribute_value(&module.attrs).unwrap().as_deref(),
        Some(expected_path)
    );
    assert_eq!(module.attrs.len(), 2, "测试 mod 只能有 cfg 与 path 属性");
    assert_eq!(
        module
            .attrs
            .iter()
            .filter(|attr| exact_cfg_test_attribute(attr))
            .count(),
        1,
        "测试 mod 必须且只能有一个 #[cfg(test)]"
    );
}

fn assert_test_support_module(item: &Item) {
    let Item::Mod(module) = item else {
        panic!("预期私有 test_support mod");
    };
    assert_eq!(module.ident, "test_support");
    assert!(matches!(module.vis, Visibility::Inherited));
    assert!(module.content.is_none());
    assert!(module.semi.is_some());
    assert_eq!(path_attribute_value(&module.attrs).unwrap(), None);
    assert_eq!(module.attrs.len(), 1);
    assert!(exact_cfg_test_attribute(&module.attrs[0]));
}

fn validate_plain_private_modules(file: &File, expected_modules: &[&str]) -> Result<(), String> {
    let mut actual = Vec::new();
    for item in &file.items {
        let Item::Mod(module) = item else {
            continue;
        };
        if module.ident == "tests" {
            continue;
        }
        if !module.attrs.is_empty() {
            return Err(format!("mod {} 不得带属性", module.ident));
        }
        if !matches!(module.vis, Visibility::Inherited) {
            return Err(format!("mod {} 必须是私有模块", module.ident));
        }
        if module.content.is_some() || module.semi.is_none() {
            return Err(format!("mod {} 必须是分号结尾的外置模块", module.ident));
        }
        actual.push(module.ident.to_string());
    }
    actual.sort();
    let mut expected = expected_modules
        .iter()
        .map(|module| (*module).to_string())
        .collect::<Vec<_>>();
    expected.sort();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "生产 mod 清单不精确: actual={actual:?}, expected={expected:?}"
        ))
    }
}

fn item_is_test_conditioned(item: &Item) -> bool {
    attributes_are_test_conditioned(item_attributes(item))
}

fn attributes_are_test_conditioned(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute_enables_test(attribute) || attribute_generates_test_marker(attribute)
    })
}

#[derive(Default)]
struct EmbeddedTestVisitor {
    test_functions: usize,
    inline_tests: usize,
    test_conditioned_items: usize,
}

fn item_attributes(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::ExternCrate(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::ForeignMod(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::TraitAlias(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        Item::Verbatim(_) => &[],
        _ => &[],
    }
}

fn impl_item_attributes(item: &ImplItem) -> &[Attribute] {
    match item {
        ImplItem::Const(item) => &item.attrs,
        ImplItem::Fn(item) => &item.attrs,
        ImplItem::Type(item) => &item.attrs,
        ImplItem::Macro(item) => &item.attrs,
        ImplItem::Verbatim(_) => &[],
        _ => &[],
    }
}

fn trait_item_attributes(item: &TraitItem) -> &[Attribute] {
    match item {
        TraitItem::Const(item) => &item.attrs,
        TraitItem::Fn(item) => &item.attrs,
        TraitItem::Type(item) => &item.attrs,
        TraitItem::Macro(item) => &item.attrs,
        TraitItem::Verbatim(_) => &[],
        _ => &[],
    }
}

fn foreign_item_attributes(item: &ForeignItem) -> &[Attribute] {
    match item {
        ForeignItem::Fn(item) => &item.attrs,
        ForeignItem::Static(item) => &item.attrs,
        ForeignItem::Type(item) => &item.attrs,
        ForeignItem::Macro(item) => &item.attrs,
        ForeignItem::Verbatim(_) => &[],
        _ => &[],
    }
}

impl EmbeddedTestVisitor {
    fn record_member_attributes(&mut self, attributes: &[Attribute]) {
        if attributes_are_test_conditioned(attributes) {
            self.test_conditioned_items += 1;
        }
        if has_test_attribute(attributes) {
            self.test_functions += 1;
        }
    }
}

impl<'ast> Visit<'ast> for EmbeddedTestVisitor {
    fn visit_item(&mut self, item: &'ast Item) {
        if item_is_test_conditioned(item) {
            self.test_conditioned_items += 1;
        }
        syn::visit::visit_item(self, item);
    }

    fn visit_item_fn(&mut self, function: &'ast syn::ItemFn) {
        if has_test_attribute(&function.attrs) {
            self.test_functions += 1;
        }
        syn::visit::visit_item_fn(self, function);
    }

    fn visit_item_mod(&mut self, module: &'ast ItemMod) {
        if module.ident == "tests" && module.content.is_some() {
            self.inline_tests += 1;
        }
        syn::visit::visit_item_mod(self, module);
    }

    fn visit_impl_item(&mut self, item: &'ast ImplItem) {
        self.record_member_attributes(impl_item_attributes(item));
        syn::visit::visit_impl_item(self, item);
    }

    fn visit_trait_item(&mut self, item: &'ast TraitItem) {
        self.record_member_attributes(trait_item_attributes(item));
        syn::visit::visit_trait_item(self, item);
    }

    fn visit_foreign_item(&mut self, item: &'ast ForeignItem) {
        self.record_member_attributes(foreign_item_attributes(item));
        syn::visit::visit_foreign_item(self, item);
    }
}

fn inspect_embedded_tests(file: &File) -> EmbeddedTestVisitor {
    let mut visitor = EmbeddedTestVisitor::default();
    visitor.visit_file(file);
    visitor
}

fn validate_root_fragment_owned_module(file: &File, source_name: &str) -> Result<(), String> {
    let visitor = inspect_embedded_tests(file);
    let mut violations = Vec::new();
    if visitor.test_functions != 0 {
        violations.push(format!("测试函数={}", visitor.test_functions));
    }
    if visitor.inline_tests != 0 {
        violations.push(format!("inline mod tests={}", visitor.inline_tests));
    }
    if visitor.test_conditioned_items != 0 {
        violations.push(format!("测试条件 item={}", visitor.test_conditioned_items));
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{source_name} 必须由根测试片段拥有全部测试，不得嵌入测试形态: {}",
            violations.join(", ")
        ))
    }
}

fn assert_no_embedded_test_shapes(visitor: &EmbeddedTestVisitor, source_name: &str) {
    assert_eq!(visitor.test_functions, 0, "{source_name} 残留测试函数");
    assert_eq!(
        visitor.inline_tests, 0,
        "{source_name} 残留 inline mod tests"
    );
}

fn include_literal_path(item_macro: &ItemMacro) -> Result<Option<String>, String> {
    if item_macro
        .mac
        .path
        .segments
        .last()
        .is_none_or(|segment| segment.ident != "include")
    {
        return Ok(None);
    }
    syn::parse2::<LitStr>(item_macro.mac.tokens.clone())
        .map(|literal| Some(literal.value()))
        .map_err(|_| "include! 参数必须恰好是单个字符串字面量".to_string())
}

fn strict_manifest_include_path(item_macro: &ItemMacro) -> Result<Option<String>, String> {
    if !item_macro.mac.path.is_ident("include") {
        return Ok(None);
    }
    if !item_macro.attrs.is_empty()
        || item_macro.ident.is_some()
        || item_macro.semi_token.is_none()
        || !matches!(item_macro.mac.delimiter, syn::MacroDelimiter::Paren(_))
    {
        return Err("include! 必须是无属性、圆括号、分号结尾的匿名 item macro".to_string());
    }
    include_literal_path(item_macro)
}

fn parse_root_test_manifest(source: &str) -> Result<Vec<String>, String> {
    let file = syn::parse_file(source).map_err(|error| error.to_string())?;
    let mut includes = Vec::new();
    for item in &file.items {
        match item {
            Item::Use(item_use)
                if item_use.attrs.is_empty() && matches!(item_use.vis, Visibility::Inherited) => {}
            Item::Use(_) => {
                return Err("tests/mod.rs 的 use 必须无属性且不可导出".to_string());
            }
            Item::Macro(item_macro) => match strict_manifest_include_path(item_macro)? {
                Some(path) => includes.push(path),
                None => return Err("tests/mod.rs 只允许 include! item macro".to_string()),
            },
            _ => return Err("tests/mod.rs 只允许 use 与 include! 顶层 item".to_string()),
        }
    }
    Ok(includes)
}

struct PathModuleVisitor<'a> {
    source: &'a Path,
    references: &'a mut Vec<PathModuleReference>,
}

impl<'ast> Visit<'ast> for PathModuleVisitor<'_> {
    fn visit_item_mod(&mut self, module: &'ast ItemMod) {
        if let Some(path) = path_attribute_value(&module.attrs).unwrap() {
            self.references.push(PathModuleReference {
                source: self.source.to_path_buf(),
                path,
                module: module.ident.to_string(),
            });
        }
        syn::visit::visit_item_mod(self, module);
    }
}

fn path_module_references(
    sources: &[(PathBuf, String)],
) -> Result<Vec<PathModuleReference>, String> {
    let mut references = Vec::new();
    for (source, contents) in sources {
        let file = syn::parse_file(contents)
            .map_err(|error| format!("解析 {} 失败: {error}", source.display()))?;
        PathModuleVisitor {
            source,
            references: &mut references,
        }
        .visit_file(&file);
    }
    references.sort();
    Ok(references)
}

#[derive(Default)]
struct IncludeVisitor {
    paths: Vec<String>,
    error: Option<String>,
}

impl<'ast> Visit<'ast> for IncludeVisitor {
    fn visit_item_macro(&mut self, item_macro: &'ast ItemMacro) {
        if self.error.is_some() {
            return;
        }
        match include_literal_path(item_macro) {
            Ok(Some(path)) => self.paths.push(path),
            Ok(None) => {}
            Err(error) => self.error = Some(error),
        }
        syn::visit::visit_item_macro(self, item_macro);
    }
}

fn collect_include_paths(file: &File) -> Result<Vec<String>, String> {
    let mut visitor = IncludeVisitor::default();
    visitor.visit_file(file);
    match visitor.error {
        Some(error) => Err(error),
        None => Ok(visitor.paths),
    }
}

#[test]
fn lib_root_keeps_test_modules_external() {
    let file = parse_source(source_root().join("lib.rs"));
    let visitor = inspect_embedded_tests(&file);
    assert_no_embedded_test_shapes(&visitor, "lib.rs");
    assert_eq!(
        visitor.test_conditioned_items, 4,
        "lib.rs 仅允许四个测试条件私有 item：test_support、\
         request_assembly_measurements、retry_marker_tests、tests"
    );
    assert!(file.items.len() >= 2);
    assert_external_test_module(
        &file.items[file.items.len() - 2],
        "tests/retry_marker.rs",
        "retry_marker_tests",
    );
    assert_external_test_module(&file.items[file.items.len() - 1], "tests/mod.rs", "tests");

    let conditioned = file
        .items
        .iter()
        .filter(|item| item_is_test_conditioned(item))
        .collect::<Vec<_>>();
    assert_eq!(conditioned.len(), 4);
    let conditioned_mod_idents = conditioned
        .iter()
        .filter_map(|item| match item {
            syn::Item::Mod(module) => Some(module.ident.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        conditioned_mod_idents,
        vec![
            "request_assembly_measurements".to_string(),
            "test_support".to_string(),
            "retry_marker_tests".to_string(),
            "tests".to_string(),
        ],
        "lib.rs 的测试条件 mod 清单必须精确"
    );
    let conditioned_uses = conditioned
        .iter()
        .filter(|item| matches!(item, syn::Item::Use(_)))
        .count();
    assert_eq!(conditioned_uses, 0, "lib.rs 不允许条件 use");
    assert_test_support_module(
        conditioned
            .iter()
            .find(|item| matches!(item, syn::Item::Mod(m) if m.ident == "test_support"))
            .expect("test_support mod 必须存在"),
    );

    let root_test_modules = file
        .items
        .iter()
        .filter(|item| {
            matches!(item, Item::Mod(module) if path_attribute_value(&module.attrs).unwrap().as_deref().is_some_and(|path| path == "tests/retry_marker.rs" || path == "tests/mod.rs"))
        })
        .count();
    assert_eq!(root_test_modules, 2, "根测试 mod 不得重复");
}

#[test]
fn runtime_modules_keep_tests_external() {
    for &(module, unit) in RUNTIME_UNITS {
        let file = parse_source(source_root().join(module));
        let visitor = inspect_embedded_tests(&file);
        assert_no_embedded_test_shapes(&visitor, module);
        assert_eq!(
            visitor.test_conditioned_items, 1,
            "{module} 仅允许一个测试条件 mod"
        );
        assert_external_test_module(
            file.items.last().expect("runtime 文件不能为空"),
            &format!("tests/{unit}"),
            "tests",
        );
    }
}

#[test]
fn module_local_units_keep_tests_external() {
    for &(module, unit) in MODULE_LOCAL_UNITS {
        let file = parse_source(source_root().join(module));
        let visitor = inspect_embedded_tests(&file);
        assert_no_embedded_test_shapes(&visitor, module);
        let conditioned_mods = file
            .items
            .iter()
            .filter(|item| item_is_test_conditioned(item) && matches!(item, syn::Item::Mod(_)))
            .count();
        let conditioned_other = visitor.test_conditioned_items - conditioned_mods;
        assert_eq!(conditioned_mods, 1, "{module} 仅允许一个测试条件 mod");
        for item in file
            .items
            .iter()
            .filter(|item| item_is_test_conditioned(item))
        {
            assert!(
                matches!(item, syn::Item::Mod(_) | syn::Item::Use(_)),
                "{module} 的测试条件 item 只允许 mod 与 use 再导出"
            );
        }
        assert_external_test_module(file.items.last().expect("生产文件不能为空"), unit, "tests");
    }
}

#[test]
fn root_fragment_owned_modules_reject_embedded_tests() {
    for module in ROOT_FRAGMENT_OWNED_MODULES {
        let file = parse_source(source_root().join(module));
        validate_root_fragment_owned_module(&file, module)
            .unwrap_or_else(|error| panic!("{error}"));
    }
}

#[test]
fn root_fragment_owned_module_validator_rejects_test_shapes() {
    let invalid = [
        (
            "inline mod tests",
            r#"
                #[cfg(test)]
                mod tests {
                    #[test]
                    fn embedded() {}
                }
            "#,
        ),
        (
            "cfg(test) helper",
            r#"
                #[cfg(test)]
                fn helper() {}
            "#,
        ),
        (
            "direct test marker",
            r#"
                #[test]
                fn embedded() {}
            "#,
        ),
        (
            "parameterized tokio test marker",
            r#"
                #[tokio::test(flavor = "current_thread")]
                async fn embedded() {}
            "#,
        ),
        (
            "cfg_attr generated test marker",
            r#"
                #[cfg_attr(feature = "test-shape", test)]
                fn embedded() {}
            "#,
        ),
        (
            "cfg_attr generated cfg(test)",
            r#"
                #[cfg_attr(feature = "test-shape", cfg(test))]
                fn helper() {}
            "#,
        ),
        (
            "recursive cfg_attr generated cfg(test)",
            r#"
                #[cfg_attr(feature = "outer", cfg_attr(feature = "inner", cfg(test)))]
                fn helper() {}
            "#,
        ),
        (
            "impl method member",
            r#"
                struct Target;
                impl Target {
                    #[cfg(test)]
                    fn helper() {}
                }
            "#,
        ),
        (
            "impl const member",
            r#"
                struct Target;
                impl Target {
                    #[cfg(test)]
                    const HELPER: () = ();
                }
            "#,
        ),
        (
            "impl type member",
            r#"
                trait Contract { type Helper; }
                struct Target;
                impl Contract for Target {
                    #[cfg(test)]
                    type Helper = ();
                }
            "#,
        ),
        (
            "trait method member",
            r#"
                trait Target {
                    #[cfg(test)]
                    fn helper();
                }
            "#,
        ),
        (
            "trait const member",
            r#"
                trait Target {
                    #[cfg(test)]
                    const HELPER: ();
                }
            "#,
        ),
        (
            "trait type member",
            r#"
                trait Target {
                    #[cfg(test)]
                    type Helper;
                }
            "#,
        ),
        (
            "foreign function member",
            r#"
                extern "C" {
                    #[cfg(test)]
                    fn helper();
                }
            "#,
        ),
        (
            "foreign static member",
            r#"
                extern "C" {
                    #[cfg(test)]
                    static HELPER: i32;
                }
            "#,
        ),
        (
            "foreign type member",
            r#"
                extern "C" {
                    #[cfg(test)]
                    type Helper;
                }
            "#,
        ),
        (
            "double not enables test",
            r#"
                #[cfg(not(not(test)))]
                fn helper() {}
            "#,
        ),
    ];
    let false_negatives = invalid
        .into_iter()
        .filter_map(|(name, source)| {
            let file = syn::parse_file(source).unwrap();
            validate_root_fragment_owned_module(&file, name)
                .is_ok()
                .then_some(name)
        })
        .collect::<Vec<_>>();
    assert!(
        false_negatives.is_empty(),
        "新门禁必须拒绝旧检查遗漏的测试形态: {false_negatives:?}"
    );

    let production_only = syn::parse_file(
        r#"
            #[cfg(not(test))]
            fn production_only() {}
        "#,
    )
    .unwrap();
    assert!(
        validate_root_fragment_owned_module(&production_only, "cfg(not(test))").is_ok(),
        "cfg(not(test)) 是生产态 item，不得误报"
    );
}

#[test]
fn root_fragments_are_included_exactly_once() {
    let src = source_root();
    let tests_root = src.join("tests");
    let actual = parse_root_test_manifest(&read(tests_root.join("mod.rs")))
        .expect("tests/mod.rs 不是纯测试清单");
    let actual_set = actual.iter().cloned().collect::<BTreeSet<_>>();
    let expected_set = ROOT_FRAGMENTS
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(actual.len(), actual_set.len(), "存在重复 include");
    assert_eq!(actual_set, expected_set);

    let mut all_includes = Vec::new();
    for path in rust_sources_below(&src) {
        all_includes.extend(
            collect_include_paths(&parse_source(&path))
                .unwrap_or_else(|error| panic!("{}: {error}", path.display())),
        );
    }
    for fragment in ROOT_FRAGMENTS {
        assert!(tests_root.join(fragment).is_file(), "缺少 {fragment}");
        assert_eq!(
            all_includes.iter().filter(|path| path == fragment).count(),
            1,
            "{fragment} 应仅被 include 一次"
        );
    }
}

/// 被多个测试片段经 `#[path]` 共享的夹具文件（不属于任何单一清单）。
const TEST_FIXTURES: &[&str] = &["internal_provider_failure_fixture.rs"];

#[test]
fn test_source_inventory_is_recursive_and_exact() {
    let tests_root = source_root().join("tests");
    let expected = ROOT_FRAGMENTS
        .iter()
        .copied()
        .chain(RUNTIME_UNITS.iter().map(|(_, unit)| *unit))
        .chain(TEST_FIXTURES.iter().copied())
        .chain(["mod.rs", "retry_marker.rs"])
        .map(PathBuf::from)
        .collect::<BTreeSet<_>>();
    validate_rust_inventory(&tests_root, &expected)
        .unwrap_or_else(|(missing, orphaned)| panic!("缺失: {missing:?}; 孤儿: {orphaned:?}"));
}

#[test]
fn module_local_test_source_inventory_is_recursive_and_exact() {
    validate_module_local_test_inventory(
        &source_root(),
        MODULE_LOCAL_UNITS,
        MODULE_LOCAL_PRODUCTION_MODULES,
        MODULE_LOCAL_TEST_INCLUDE_FRAGMENTS,
    )
    .unwrap_or_else(|(missing, orphaned)| panic!("缺失: {missing:?}; 孤儿: {orphaned:?}"));
}

#[test]
fn module_local_test_include_fragments_are_exact() {
    let manifests = MODULE_LOCAL_TEST_INCLUDE_FRAGMENTS
        .iter()
        .map(|(manifest, _, _)| *manifest)
        .collect::<BTreeSet<_>>();
    for manifest in manifests {
        let expected = MODULE_LOCAL_TEST_INCLUDE_FRAGMENTS
            .iter()
            .filter_map(|(owner, include, _)| {
                (*owner == manifest).then_some((*include).to_string())
            })
            .collect::<Vec<_>>();
        let actual = collect_include_paths(&parse_source(source_root().join(manifest)))
            .unwrap_or_else(|error| panic!("{manifest}: {error}"));
        assert_eq!(actual, expected, "{manifest} 的 include 清单必须精确匹配");
    }
}

#[test]
fn module_local_production_units_reject_embedded_tests() {
    for (_, _, module) in MODULE_LOCAL_PRODUCTION_MODULES {
        let file = parse_source(source_root().join(module));
        validate_root_fragment_owned_module(&file, module)
            .unwrap_or_else(|error| panic!("{error}"));
    }
}

#[test]
fn module_local_production_module_references_are_exact() {
    let sources = MODULE_LOCAL_PRODUCTION_MODULES
        .iter()
        .map(|(source, _, _)| *source)
        .collect::<BTreeSet<_>>();
    for source in sources {
        let expected = MODULE_LOCAL_PRODUCTION_MODULES
            .iter()
            .filter_map(|(owner, module, _)| (*owner == source).then_some(*module))
            .collect::<Vec<_>>();
        validate_plain_private_modules(&parse_source(source_root().join(source)), &expected)
            .unwrap_or_else(|error| panic!("{source}: {error}"));
    }

    let invalid = [
        ("missing", "mod history;"),
        ("duplicate", "mod history; mod history; mod protocol;"),
        ("inline", "mod history {} mod protocol;"),
        (
            "path",
            "#[path = \"elsewhere.rs\"] mod history; mod protocol;",
        ),
        ("public", "pub mod history; mod protocol;"),
        ("cfg", "#[cfg(unix)] mod history; mod protocol;"),
        ("wrong target", "mod history; mod other;"),
    ];
    for (name, source) in invalid {
        let file = syn::parse_file(source).unwrap();
        assert!(
            validate_plain_private_modules(&file, &["history", "protocol"]).is_err(),
            "非法生产 mod 形态不应通过: {name}"
        );
    }
}

#[test]
fn runtime_path_modules_match_exact_reference_inventory() {
    let src = source_root();
    let tests_root = src.join("tests");
    let sources = rust_sources_below(&src)
        .into_iter()
        .filter(|path| !path.starts_with(&tests_root))
        .map(|path| {
            let contents = read(&path);
            (path.strip_prefix(&src).unwrap().to_path_buf(), contents)
        })
        .collect::<Vec<_>>();
    let actual = path_module_references(&sources).unwrap();
    let mut expected = RUNTIME_UNITS
        .iter()
        .map(|(module, unit)| PathModuleReference {
            source: PathBuf::from(module),
            path: format!("tests/{unit}"),
            module: "tests".to_string(),
        })
        .chain([
            PathModuleReference {
                source: PathBuf::from("background_runtime.rs"),
                path: "background_delivery_runtime.rs".to_string(),
                module: "delivery".to_string(),
            },
            PathModuleReference {
                source: PathBuf::from("lib.rs"),
                path: "tests/retry_marker.rs".to_string(),
                module: "retry_marker_tests".to_string(),
            },
            PathModuleReference {
                source: PathBuf::from("session_end_runtime/tests.rs"),
                path: "../tests/internal_provider_failure_fixture.rs".to_string(),
                module: "internal_failure_fixture".to_string(),
            },
            PathModuleReference {
                source: PathBuf::from("lib.rs"),
                path: "tests/mod.rs".to_string(),
                module: "tests".to_string(),
            },
        ])
        .chain(
            MODULE_LOCAL_UNITS
                .iter()
                .map(|(module, unit)| PathModuleReference {
                    source: PathBuf::from(module),
                    path: (*unit).to_string(),
                    module: "tests".to_string(),
                }),
        )
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(actual, expected, "测试 path mod 引用清单不精确");
}

#[test]
fn manifest_ast_contract_accepts_only_plain_use_and_exact_include() {
    let valid = r##"
        // pub(crate) fn fake() { include!("fake.rs"); }
        /* outer /* include!("also_fake.rs"); */ pub fn fake() {} */
        use crate::{Engine, Query};
        include!(r#"real.rs"#);
    "##;
    assert_eq!(parse_root_test_manifest(valid).unwrap(), vec!["real.rs"]);

    let invalid = [
        "pub(crate) fn helper() {}",
        "#[cfg(test)] fn helper() {}",
        "pub(crate)\nfn helper() {}",
        "struct Helper;",
        "enum Helper { Value }",
        "impl Helper {}",
        "type Helper = ();",
        "static HELPER: () = ();",
        "const HELPER: () = ();",
        "mod nested;",
        "assert!(true);",
        "custom_macro! {}",
        "#[allow(unused)] use crate::Engine;",
        "pub(crate) use crate::Engine;",
        "include!(\"one.rs\", \"two.rs\");",
        "include! { \"wrong_delimiter.rs\" }",
        "#[cfg(test)] include!(\"attributed.rs\");",
        "std::include!(\"qualified.rs\");",
    ];
    for source in invalid {
        assert!(
            parse_root_test_manifest(source).is_err(),
            "绕过样例不应通过: {source}"
        );
    }
}

#[test]
fn ast_detects_all_test_conditioned_items_and_respects_cfg_polarity() {
    let file = syn::parse_file(
        r#"
            #[tokio::test(flavor = "multi_thread")]
            async fn async_test() {}
            fn wrapper() {
                #[test]
                fn nested_test() {}
            }
            mod tests {
                fn helper() {}
            }
            #[cfg(test)]
            fn cfg_test_fn() {}
            #[cfg(all(test))]
            struct TestStruct;
            struct Target;
            #[cfg(test)]
            impl Target {}
            #[cfg(test)]
            const TEST_CONST: () = ();
            #[cfg(test)]
            type TestType = ();
            #[cfg(test)]
            static TEST_STATIC: () = ();
            #[cfg_attr(test, test)]
            fn cfg_attr_test() {}
            #[cfg_attr(feature = "x", test)]
            fn feature_generated_test() {}
            #[cfg_attr(feature = "x", tokio::test)]
            async fn feature_generated_async_test() {}
            #[cfg_attr(feature = "x", cfg_attr(feature = "y", tokio::test(flavor = "current_thread")))]
            async fn recursively_generated_async_test() {}
            #[cfg(all(unix, any(feature = "x", test)))]
            pub(crate) use crate::Hidden;
            #[cfg(not(test))]
            fn production_only() {}
        "#,
    )
    .unwrap();
    let visitor = inspect_embedded_tests(&file);
    assert_eq!(visitor.test_functions, 6);
    assert_eq!(visitor.inline_tests, 1);
    assert_eq!(visitor.test_conditioned_items, 11);
}

#[test]
fn include_inventory_counts_noncanonical_forms_and_propagates_invalid_arguments() {
    let duplicate_file = syn::parse_file(
        r#"
            include!("duplicate.rs");
            #[cfg(test)]
            std::include! { "duplicate.rs" }
            core::include!("duplicate.rs");
        "#,
    )
    .unwrap();
    assert_eq!(
        collect_include_paths(&duplicate_file).unwrap(),
        vec!["duplicate.rs", "duplicate.rs", "duplicate.rs"]
    );

    let dynamic_file = syn::parse_file(r#"std::include!(concat!("dynamic", ".rs"));"#).unwrap();
    assert!(collect_include_paths(&dynamic_file).is_err());
}

#[test]
fn path_module_reference_collection_preserves_duplicate_occurrences() {
    let sources = vec![(
        PathBuf::from("runtime.rs"),
        r#"
            #[cfg(test)] #[path = "tests/runtime_unit.rs"] mod tests;
            #[cfg(test)] #[path = "tests/runtime_unit.rs"] mod tests_again;
        "#
        .to_string(),
    )];
    let references = path_module_references(&sources).unwrap();
    assert_eq!(references.len(), 2);
    assert_eq!(references[0].path, references[1].path);
}

#[test]
fn recursive_inventory_detects_nested_orphan() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("declared.rs"), "").unwrap();
    fs::write(temp.path().join("nested/orphan.rs"), "").unwrap();
    let expected = BTreeSet::from([PathBuf::from("declared.rs")]);
    let (missing, orphaned) = validate_rust_inventory(temp.path(), &expected).unwrap_err();
    assert!(missing.is_empty());
    assert_eq!(
        orphaned,
        BTreeSet::from([PathBuf::from("nested/orphan.rs")])
    );
}

#[test]
fn module_local_inventory_detects_nested_orphan() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("context/compact/nested")).unwrap();
    fs::write(temp.path().join("context/compact/tests.rs"), "").unwrap();
    fs::write(temp.path().join("context/compact/nested/orphan.rs"), "").unwrap();

    let units = [("context/compact.rs", "compact/tests.rs")];
    let (missing, orphaned) =
        validate_module_local_test_inventory(temp.path(), &units, &[], &[]).unwrap_err();
    assert!(missing.is_empty());
    assert_eq!(
        orphaned,
        BTreeSet::from([PathBuf::from("context/compact/nested/orphan.rs")])
    );
}
