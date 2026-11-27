use super::temp_store;
use crate::{PREFERENCE_VALUE_MAX_CHARS, parse_preference_key};

#[test]
fn preference_keys_name_scope_and_category() {
    assert_eq!(
        parse_preference_key("pref.global.tone").unwrap(),
        ("global", "tone")
    );
    for invalid in [
        "tone",
        "pref.global",
        "pref..tone",
        "pref.a.b.c",
        "pref.glo bal.tone",
    ] {
        assert!(parse_preference_key(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn preference_updates_are_revision_checked_bounded_and_cleared_with_the_scope() {
    let (_temp, store) = temp_store();
    assert_eq!(store.read_preferences().unwrap().revision, 0);
    let document = store
        .update_preference("pref.global.tone", Some("Concise"), 0, 5)
        .unwrap();
    assert_eq!(document.revision, 1);
    assert_eq!(document.items["pref.global.tone"].updated_at_ms, 5);
    let conflict = store
        .update_preference("pref.global.tone", None, 0, 6)
        .unwrap_err();
    assert_eq!(conflict.code(), "evolution_revision_conflict");
    let large = "x".repeat(PREFERENCE_VALUE_MAX_CHARS + 1);
    let too_large = store
        .update_preference("pref.global.tone", Some(&large), 1, 6)
        .unwrap_err();
    assert_eq!(too_large.code(), "evolution_content_too_large");
    let deleted = store
        .update_preference("pref.global.tone", None, 1, 7)
        .unwrap();
    assert!(deleted.items.is_empty());
    store
        .update_preference("pref.global.tone", Some("Short"), 2, 8)
        .unwrap();
    store.clear_all().unwrap();
    assert_eq!(store.read_preferences().unwrap().revision, 0);
}
