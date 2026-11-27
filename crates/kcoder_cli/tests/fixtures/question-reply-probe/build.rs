use std::{env, fs, path::PathBuf};

fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let start = source.find(start).expect("production section start");
    let end = source[start..].find(end).expect("production section end") + start;
    &source[start..end]
}

fn main() {
    let source = PathBuf::from("../../../src/app_server/interaction_requests.rs");
    let tests = PathBuf::from("../../../src/app_server/tests/approvals_questions.rs");
    for path in [&source, &tests] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let source = fs::read_to_string(source).expect("production reply source");
    let mut extracted = section(
        &source,
        "pub fn resolve_server_response(",
        "\nimpl InteractionReceipts {",
    )
    .to_owned();
    extracted.push_str("\nimpl InteractionReceipts {\n");
    extracted.push_str(section(
        &source,
        "    pub fn track_request(",
        "    /// Drops an interaction",
    ));
    extracted.push_str(section(
        &source,
        "    pub fn expected_binding(",
        "    pub fn note_misattributed(",
    ));
    extracted.push_str("\n}\n");
    let tests = fs::read_to_string(tests).expect("original native regression tests");
    let start = tests
        .find(
            "#[test]\nfn native_question_rejects_foreign_items_without_consuming_original_waiter()",
        )
        .expect("native regression start");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    fs::write(output.join("replies.rs"), extracted).expect("generated production slice");
    fs::write(output.join("tests.rs"), &tests[start..]).expect("generated original tests");
}
