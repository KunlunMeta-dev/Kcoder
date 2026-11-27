//! Terminal question rendering for the headless interactive CLI route.
use async_trait::async_trait;
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use std::io::Write;

pub struct HeadlessUserQuestioner;

#[async_trait]
impl UserQuestioner for HeadlessUserQuestioner {
    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        let mut answers = std::collections::HashMap::new();
        for question in request.questions {
            eprintln!("\n[Question] {}", question.question);
            for (i, opt) in question.options.iter().enumerate() {
                eprintln!("  {}. {} - {}", i + 1, opt.label, opt.description);
            }
            eprint!(
                "Enter choice number{}: ",
                if question.multi_select {
                    "s (comma-separated)"
                } else {
                    ""
                }
            );
            let _ = std::io::stderr().flush();
            let mut line = String::new();
            match std::io::stdin().read_line(&mut line) {
                Ok(_) => {
                    let indices: Vec<usize> = line
                        .split(',')
                        .filter_map(|s| s.trim().parse::<usize>().ok())
                        .filter(|&n| n > 0 && n <= question.options.len())
                        .collect();
                    let selected: Vec<String> = indices
                        .iter()
                        .map(|&n| question.options[n - 1].label.clone())
                        .collect();
                    if selected.is_empty() {
                        return Err("no valid option selected".to_string());
                    }
                    answers.insert(question.question, selected.join(", "));
                }
                Err(e) => return Err(format!("failed to read answer: {}", e)),
            }
        }
        Ok(UserQuestionResponse {
            questions: Vec::new(),
            answers,
            annotations: None,
        })
    }
}
