fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&schemars::schema_for!(
            kcoder_common_types::StorageMigrationReceipt
        ))
        .unwrap()
    );
}
