//! Lossless display metadata derived only after the original native reply binding is checked.
use kcoder_app_protocol::QuestionAnswer;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub(super) fn from_native_reply(
    original: Option<Value>,
    question_count: usize,
    answers: &BTreeMap<String, QuestionAnswer>,
) -> Value {
    let mut annotations = match original {
        Some(Value::Object(value)) => value,
        Some(value) => Map::from_iter([("original_annotations".into(), value)]),
        None => Map::new(),
    };
    let lists = (0..question_count)
        .filter_map(|index| {
            let id = format!("question-{}", index + 1);
            answers.get(&id).map(|answer| {
                (
                    id,
                    Value::Array(answer.answers.iter().cloned().map(Value::String).collect()),
                )
            })
        })
        .collect();
    // Model/request annotations cannot claim a selected answer or grant. This
    // reserved value is replaced with the original native response vectors.
    annotations.insert("answer_lists".into(), Value::Object(lists));
    Value::Object(annotations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn comma_labels_and_multiple_values_remain_lossless_and_override_untrusted_metadata() {
        let answers = BTreeMap::from([
            (
                "question-1".into(),
                QuestionAnswer {
                    answers: vec!["Budget, revised".into(), "Original source".into()],
                },
            ),
            (
                "question-99".into(),
                QuestionAnswer {
                    answers: vec!["foreign question".into()],
                },
            ),
        ]);
        let observed = from_native_reply(
            Some(json!({"autoResolved":false,"answer_lists":{"question-1":["forged"]}})),
            1,
            &answers,
        );
        assert_eq!(
            observed,
            json!({"autoResolved":false,"answer_lists":{"question-1":["Budget, revised","Original source"]}})
        );
        assert_eq!(answers["question-1"].answers.len(), 2);
    }

    #[test]
    fn existing_nonobject_annotations_are_retained_without_creating_answers() {
        assert_eq!(
            from_native_reply(Some(json!(["legacy", "note"])), 1, &BTreeMap::new()),
            json!({"original_annotations":["legacy","note"],"answer_lists":{}})
        );
        assert_eq!(
            from_native_reply(None, 0, &BTreeMap::new()),
            json!({"answer_lists":{}})
        );
    }
}
