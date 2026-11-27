//! Document paths stage of configuration loading.

use super::*;

pub fn set_dotted_value(root: &mut Value, key: &str, value: Value) -> Result<()> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in &parts[..parts.len() - 1] {
        let object = cursor
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("setting parent '{}' is not an object", part))?;
        cursor = object
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    let object = cursor
        .as_object_mut()
        .context("settings root is not a JSON object")?;
    object.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

pub fn remove_dotted_value(root: &mut Value, key: &str) -> Result<bool> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in &parts[..parts.len() - 1] {
        let Some(next) = cursor
            .as_object_mut()
            .and_then(|object| object.get_mut(*part))
        else {
            return Ok(false);
        };
        cursor = next;
    }
    Ok(cursor
        .as_object_mut()
        .and_then(|object| object.remove(parts[parts.len() - 1]))
        .is_some())
}

pub fn dotted_value<'a>(root: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    let parts = dotted_parts(key)?;
    let mut cursor = root;
    for part in parts {
        let Some(next) = cursor.as_object().and_then(|object| object.get(part)) else {
            return Ok(None);
        };
        cursor = next;
    }
    Ok(Some(cursor))
}

pub(super) fn dotted_parts(key: &str) -> Result<Vec<&str>> {
    let parts = key.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(|part| part.trim().is_empty()) {
        bail!("setting name must be a non-empty dotted path");
    }
    Ok(parts)
}
