use kcoder_app_protocol::{
    PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1, RetentionParentLaunchV1,
    decode_private_retention_parent_environment,
};

#[test]
fn private_parent_environment_decodes_the_two_typed_facts() {
    assert_eq!(
        decode_private_retention_parent_environment(r#"{"version":1,"mode":"localOs"}"#).unwrap(),
        RetentionParentLaunchV1::LocalOs
    );
    assert_eq!(
        decode_private_retention_parent_environment(
            r#"{"version":1,"mode":"verifiedAccount","principalId":"account-1","uid":1234}"#
        )
        .unwrap(),
        RetentionParentLaunchV1::VerifiedAccount {
            principal_id: "account-1".into(),
            uid: 1234,
        }
    );
}

#[test]
fn private_parent_environment_rejects_duplicate_unknown_and_invalid_discriminators() {
    for raw in [
        r#"{"version":1,"version":1,"mode":"localOs"}"#,
        r#"{"version":1,"mode":"localOs","principalId":"not-allowed"}"#,
        r#"{"version":1,"mode":"localOs","unexpected":true}"#,
        r#"{"version":1,"mode":"verifiedAccount","principalId":"a","uid":1,"unexpected":true}"#,
        r#"{"version":2,"mode":"localOs"}"#,
        r#"{"version":1,"mode":"other"}"#,
        r#"{"version":1,"mode":"verifiedAccount","principalId":"a","principalId":"b","uid":1}"#,
    ] {
        assert!(
            decode_private_retention_parent_environment(raw).is_err(),
            "private parent declaration must reject {raw}"
        );
    }
}

#[test]
fn private_parent_environment_enforces_principal_and_uid_bounds() {
    let accepted = format!(
        r#"{{"version":1,"mode":"verifiedAccount","principalId":"{}","uid":4294967295}}"#,
        "a".repeat(256)
    );
    assert!(decode_private_retention_parent_environment(&accepted).is_ok());

    for raw in [
        format!(
            r#"{{"version":1,"mode":"verifiedAccount","principalId":"{}","uid":1}}"#,
            "a".repeat(257)
        ),
        r#"{"version":1,"mode":"verifiedAccount","principalId":"","uid":1}"#.into(),
        r#"{"version":1,"mode":"verifiedAccount","principalId":"\u0000","uid":1}"#.into(),
        r#"{"version":1,"mode":"verifiedAccount","principalId":"a","uid":-1}"#.into(),
        r#"{"version":1,"mode":"verifiedAccount","principalId":"a","uid":4294967296}"#.into(),
        r#"{"version":1,"mode":"verifiedAccount","principalId":"a","uid":1.5}"#.into(),
        r#"{"version":256,"mode":"localOs"}"#.into(),
    ] {
        assert!(
            decode_private_retention_parent_environment(&raw).is_err(),
            "invalid principal/version/UID must reject {raw}"
        );
    }
}

#[test]
fn private_parent_environment_accepts_exact_json_limit_and_rejects_one_byte_over() {
    let prefix = r#"{"version":1,"mode":"localOs"}"#;
    let at_limit = format!(
        "{prefix}{}",
        " ".repeat(PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1 - prefix.len())
    );
    assert_eq!(at_limit.len(), PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1);
    assert_eq!(
        decode_private_retention_parent_environment(&at_limit).unwrap(),
        RetentionParentLaunchV1::LocalOs
    );

    let over_limit = format!("{at_limit} ");
    assert!(
        decode_private_retention_parent_environment(&over_limit).is_err(),
        "the raw UTF-8 JSON byte limit is inclusive at 1024 bytes"
    );
}
