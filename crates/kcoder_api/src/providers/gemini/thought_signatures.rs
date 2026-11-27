//! Gemini `thoughtSignature` round trips.
//!
//! A signature belongs to one response part. Normalized content has no field
//! for it on text or tool blocks, so the adapter records it in a `Thinking`
//! block signature with an explicit anchor:
//! - `self`: the Thinking block itself is the signed part (a thought part, or
//!   an empty text part when the block has no thinking text);
//! - `next`: the immediately following ToolUse block is the signed
//!   `functionCall` part;
//! - `previous`: the immediately preceding Text block is the signed part.
//!
//! The marker prefix keeps the value private to this protocol, so an
//! Anthropic or OpenAI signature is never sent as a Gemini signature, and
//! unsigned historical thinking is still not replayed.
use serde_json::Value;

const PREFIX: &str = "kcoder.gemini.thought_signature.v1:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Anchor {
    Own,
    Next,
    Previous,
}

impl Anchor {
    fn label(self) -> &'static str {
        match self {
            Anchor::Own => "self",
            Anchor::Next => "next",
            Anchor::Previous => "previous",
        }
    }
}

pub(super) fn encode(anchor: Anchor, signature: &str) -> String {
    format!("{PREFIX}{}:{signature}", anchor.label())
}

pub(super) fn decode(signature: &str) -> Option<(Anchor, &str)> {
    let (label, signature) = signature.strip_prefix(PREFIX)?.split_once(':')?;
    let anchor = match label {
        "self" => Anchor::Own,
        "next" => Anchor::Next,
        "previous" => Anchor::Previous,
        _ => return None,
    };
    (!signature.is_empty()).then_some((anchor, signature))
}

/// Model-turn part assembly that restores each signature onto its part.
#[derive(Default)]
pub(super) struct ModelParts {
    parts: Vec<Value>,
    /// Signature waiting for the immediately following functionCall part.
    next: Option<String>,
    /// Index of the last part when it is an unsigned plain text part.
    last_text: Option<usize>,
}

impl ModelParts {
    pub(super) fn push(&mut self, part: Value) {
        let is_call = part.get("functionCall").is_some();
        let mut part = part;
        if let Some(signature) = self.next.take()
            && is_call
        {
            part["thoughtSignature"] = Value::String(signature);
        }
        self.last_text = (part.get("text").is_some()
            && part.get("thought").is_none()
            && part.get("thoughtSignature").is_none())
        .then_some(self.parts.len());
        self.parts.push(part);
    }

    /// Thinking blocks are replayed only when they carry a Gemini signature.
    pub(super) fn push_thinking(&mut self, thinking: &str, signature: &str) {
        let Some((anchor, signature)) = decode(signature) else {
            return;
        };
        match anchor {
            Anchor::Own => {
                let part = if thinking.is_empty() {
                    serde_json::json!({"text": "", "thoughtSignature": signature})
                } else {
                    serde_json::json!({"text": thinking, "thought": true, "thoughtSignature": signature})
                };
                self.push(part);
            }
            Anchor::Next => self.next = Some(signature.to_string()),
            // Without its text part the optional text signature has no owner.
            Anchor::Previous => {
                if let Some(index) = self.last_text.take() {
                    self.parts[index]["thoughtSignature"] = Value::String(signature.to_string());
                }
            }
        }
    }

    pub(super) fn finish(self) -> Vec<Value> {
        self.parts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_round_trip_and_reject_foreign_signatures() {
        for anchor in [Anchor::Own, Anchor::Next, Anchor::Previous] {
            assert_eq!(decode(&encode(anchor, "c2ln:x")), Some((anchor, "c2ln:x")));
        }
        assert_eq!(decode("EqoBCkgIAxABGAIiQ"), None);
        assert_eq!(decode(&format!("{PREFIX}self:")), None);
        assert_eq!(decode(&format!("{PREFIX}other:sig")), None);
    }

    #[test]
    fn next_signature_binds_only_to_the_immediately_following_call() {
        let mut parts = ModelParts::default();
        parts.push_thinking("", &encode(Anchor::Next, "call-sig"));
        parts.push(serde_json::json!({"text": "not a call"}));
        parts.push(serde_json::json!({"functionCall": {"name": "read", "args": {}}}));
        let parts = parts.finish();
        assert!(
            parts
                .iter()
                .all(|part| part.get("thoughtSignature").is_none())
        );
    }
}
