use serde_json::{Number, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum CoercionResult {
    Value(Value),
    NoMatch,
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoercionOptions {
    pub semantic_boolean: bool,
    pub semantic_number: bool,
    pub semantic_integer: bool,
    pub stringify_scalars: bool,
}

impl Default for CoercionOptions {
    fn default() -> Self {
        Self {
            semantic_boolean: true,
            semantic_number: true,
            semantic_integer: true,
            stringify_scalars: true,
        }
    }
}

impl CoercionOptions {
    pub fn strict() -> Self {
        Self {
            semantic_boolean: false,
            semantic_number: false,
            semantic_integer: false,
            stringify_scalars: false,
        }
    }
}

impl From<&kcoder_config::ToolCoercionConfig> for CoercionOptions {
    fn from(config: &kcoder_config::ToolCoercionConfig) -> Self {
        Self {
            semantic_boolean: config.semantic_boolean,
            semantic_number: config.semantic_number,
            semantic_integer: config.semantic_integer,
            stringify_scalars: config.stringify_mismatched_scalar,
        }
    }
}

pub fn coerce_boolean(value: &Value) -> CoercionResult {
    match value {
        Value::Bool(boolean) => CoercionResult::Value(Value::Bool(*boolean)),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "y" | "1" | "on" => CoercionResult::Value(Value::Bool(true)),
            "false" | "no" | "n" | "0" | "off" => CoercionResult::Value(Value::Bool(false)),
            _ => CoercionResult::NoMatch,
        },
        Value::Number(number) if number.as_i64() == Some(1) || number.as_u64() == Some(1) => {
            CoercionResult::Value(Value::Bool(true))
        }
        Value::Number(number) if number.as_i64() == Some(0) || number.as_u64() == Some(0) => {
            CoercionResult::Value(Value::Bool(false))
        }
        _ => CoercionResult::NoMatch,
    }
}

pub fn coerce_number(value: &Value) -> CoercionResult {
    match value {
        Value::Number(_) => CoercionResult::Value(value.clone()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return CoercionResult::NoMatch;
            }
            if let Ok(integer) = trimmed.parse::<i64>() {
                return CoercionResult::Value(Value::Number(integer.into()));
            }
            match trimmed.parse::<f64>() {
                Ok(number) => Number::from_f64(number)
                    .map(Value::Number)
                    .map(CoercionResult::Value)
                    .unwrap_or(CoercionResult::NoMatch),
                Err(_) => CoercionResult::NoMatch,
            }
        }
        Value::Bool(true) => CoercionResult::Value(Value::Number(1.into())),
        Value::Bool(false) => CoercionResult::Value(Value::Number(0.into())),
        _ => CoercionResult::NoMatch,
    }
}

pub fn coerce_integer(value: &Value) -> CoercionResult {
    match value {
        Value::Number(number) if number.as_i64().is_some() || number.as_u64().is_some() => {
            CoercionResult::Value(value.clone())
        }
        Value::String(text) => match text.trim().parse::<i64>() {
            Ok(integer) => CoercionResult::Value(Value::Number(integer.into())),
            Err(_) => CoercionResult::NoMatch,
        },
        Value::Bool(true) => CoercionResult::Value(Value::Number(1.into())),
        Value::Bool(false) => CoercionResult::Value(Value::Number(0.into())),
        _ => CoercionResult::NoMatch,
    }
}

pub fn coerce_value(value: &Value, schema_type: &str, opts: &CoercionOptions) -> CoercionResult {
    match schema_type {
        "boolean" if opts.semantic_boolean => coerce_boolean(value),
        "integer" if opts.semantic_integer => coerce_integer(value),
        "number" if opts.semantic_number => coerce_number(value),
        "string" if opts.stringify_scalars => match value {
            Value::Number(number) => CoercionResult::Value(Value::String(number.to_string())),
            Value::Bool(boolean) => CoercionResult::Value(Value::String(boolean.to_string())),
            _ => CoercionResult::NoMatch,
        },
        _ => CoercionResult::NoMatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_boolean_accepts_common_strings_and_numbers() {
        assert_eq!(
            coerce_boolean(&Value::String("yes".to_string())),
            CoercionResult::Value(Value::Bool(true))
        );
        assert_eq!(
            coerce_boolean(&Value::String("0".to_string())),
            CoercionResult::Value(Value::Bool(false))
        );
        assert_eq!(
            coerce_boolean(&Value::Number(1.into())),
            CoercionResult::Value(Value::Bool(true))
        );
        assert_eq!(
            coerce_boolean(&Value::String("maybe".to_string())),
            CoercionResult::NoMatch
        );
    }

    #[test]
    fn semantic_number_accepts_integer_float_and_bool() {
        assert_eq!(
            coerce_number(&Value::String("42".to_string())),
            CoercionResult::Value(Value::Number(42.into()))
        );
        assert!(matches!(
            coerce_number(&Value::String("3.5".to_string())),
            CoercionResult::Value(Value::Number(_))
        ));
        assert_eq!(
            coerce_number(&Value::Bool(false)),
            CoercionResult::Value(Value::Number(0.into()))
        );
    }

    #[test]
    fn semantic_integer_rejects_fractional_strings() {
        assert_eq!(
            coerce_integer(&Value::String("42".to_string())),
            CoercionResult::Value(Value::Number(42.into()))
        );
        assert_eq!(
            coerce_integer(&Value::String("4.2".to_string())),
            CoercionResult::NoMatch
        );
    }

    #[test]
    fn strict_options_disable_all_semantic_rules() {
        let opts = CoercionOptions::strict();
        assert_eq!(
            coerce_value(&Value::String("true".to_string()), "boolean", &opts),
            CoercionResult::NoMatch
        );
        assert_eq!(
            coerce_value(&Value::String("42".to_string()), "integer", &opts),
            CoercionResult::NoMatch
        );
    }

    #[test]
    fn config_conversion_preserves_each_coercion_flag() {
        let config = kcoder_config::ToolCoercionConfig {
            semantic_boolean: false,
            semantic_number: true,
            semantic_integer: false,
            stringify_mismatched_scalar: true,
        };

        assert_eq!(
            CoercionOptions::from(&config),
            CoercionOptions {
                semantic_boolean: false,
                semantic_number: true,
                semantic_integer: false,
                stringify_scalars: true,
            }
        );
    }
}
