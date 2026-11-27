use super::*;

fn choice(record: &SourceRecord) -> IntegrationTaskCapabilitySourceChoice {
    IntegrationTaskCapabilitySourceChoice {
        source_ref: record.source_ref.clone(),
        account_ref: record.account_ref.clone(),
    }
}
pub(super) fn key(record: &SourceRecord) -> Result<String> {
    digest(&serde_json::to_value(choice(record))?)
}
pub(super) fn validate(document: &Document) -> Result<()> {
    ensure!(
        document.retained_versions.len() <= MAX_RETAINED_VERSIONS,
        "NATIVE_SOURCE_CATALOG_INVALID"
    );
    let mut references = document
        .sources
        .values()
        .map(|value| {
            (
                value.source_ref.id.clone(),
                value.source_ref.revision.clone(),
            )
        })
        .collect::<BTreeSet<_>>();
    for (stored, record) in &document.retained_versions {
        record.source_ref.validate()?;
        if let Some(account) = record.account_ref.as_ref() {
            account.validate()?;
        }
        ensure!(
            stored == &key(record)?
                && record.selector.plugin.is_some()
                && record.source_ref.id.starts_with("native-source-")
                && uuid::Uuid::parse_str(&record.source_ref.revision).is_ok()
                && references.insert((
                    record.source_ref.id.clone(),
                    record.source_ref.revision.clone()
                )),
            "NATIVE_SOURCE_CATALOG_INVALID"
        );
        record.selector.key()?;
    }
    Ok(())
}
pub(super) fn retain(document: &mut Document, record: SourceRecord) -> Result<()> {
    ensure!(
        record.selector.plugin.is_some(),
        "NATIVE_SOURCE_PLUGIN_VERSION_REQUIRED"
    );
    let key = key(&record)?;
    if let Some(previous) = document.retained_versions.get(&key) {
        ensure!(
            previous.selector == record.selector
                && previous.security_fingerprint == record.security_fingerprint
                && previous.account_ref == record.account_ref,
            "NATIVE_SOURCE_VERSION_CONFLICT"
        );
        return Ok(());
    }
    ensure!(
        document.retained_versions.len() < MAX_RETAINED_VERSIONS,
        "NATIVE_SOURCE_CATALOG_CAPACITY"
    );
    document.retained_versions.insert(key, record);
    Ok(())
}
fn matches(
    record: &SourceRecord,
    fact: &NativeMcpSourceFact,
    account: &IntegrationNullable<IntegrationRevisionRef>,
) -> bool {
    record.selector == fact.selector
        && record.security_fingerprint == fact.security_fingerprint
        && &record.account_ref == account
}
pub(super) fn for_fact<'a>(
    document: &'a Document,
    context: &NativeIntegrationContext,
    fact: &NativeMcpSourceFact,
    account: &IntegrationNullable<IntegrationRevisionRef>,
) -> Result<Option<&'a SourceRecord>> {
    let current = document.sources.get(&fact.selector.key()?);
    let retained = match &fact.leased_plugin {
        Some(proof) => !proof.verify(context)?,
        None => false,
    };
    if current.is_some_and(|record| matches(record, fact, account)) {
        return Ok(current);
    }
    if retained
        && let Some(record) = document
            .retained_versions
            .values()
            .find(|record| matches(record, fact, account))
    {
        return Ok(Some(record));
    }
    Ok(current)
}
pub(super) fn for_choice<'a>(
    document: &'a Document,
    context: &NativeIntegrationContext,
    fact: &NativeMcpSourceFact,
    requested: &IntegrationTaskCapabilitySourceChoice,
) -> Result<Option<&'a SourceRecord>> {
    let retained = match &fact.leased_plugin {
        Some(proof) => !proof.verify(context)?,
        None => false,
    };
    if let Some(record) = document.sources.get(&fact.selector.key()?)
        && record.source_ref == requested.source_ref
    {
        return Ok(Some(record));
    }
    if !retained {
        return Ok(None);
    }
    let key = digest(&serde_json::to_value(requested)?)?;
    Ok(document
        .retained_versions
        .get(&key)
        .filter(|record| record.selector == fact.selector && choice(record) == *requested))
}
