// Prompt-producing Studio slash commands. They mirror the REPL prompts in
// `crates/kcoder_repl/src/slash/{basic,conversation}_commands.rs` and are sent as
// ordinary turns of the current session.

export function initAgentsPrompt() {
  return [
    'Generate a file named AGENTS.md that serves as a contributor and agent guide for this repository.',
    'Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.',
    'Produce a clear, concise, well-structured document with descriptive headings and actionable explanations. Adapt the outline below: add sections when relevant and omit those that do not apply.',
    [
      'Document requirements:',
      '- Title the document "Repository Guidelines" and use Markdown headings.',
      '- Keep it concise; 200-400 words is optimal.',
      '- Keep explanations short, direct and specific to this repository, with examples such as commands, paths and naming patterns.',
    ].join('\n'),
    [
      'Recommended sections:',
      '- Project Structure & Module Organization: where source code, tests and assets live.',
      '- Build, Test, and Development Commands: key commands and what each does.',
      '- Coding Style & Naming Conventions: indentation, language style, naming, formatting and linting tools.',
      '- Testing Guidelines: frameworks, coverage requirements, test naming and how to run tests.',
      '- Commit & Pull Request Guidelines: conventions found in the Git history and pull request requirements.',
      '- Optional: Security & Configuration Tips, Architecture Overview or Agent-Specific Instructions.',
    ].join('\n'),
  ].join('\n\n')
}

export function ocrReviewPrompt(instructions: string) {
  return [
    'Run OpenCodeReview for this workspace using the built-in `review` model tool.',
    [
      'Required workflow:',
      '1. First call `review` with `{ "command": "review", "preview": true }` to show the current review scope.',
      '2. If the scope is reasonably small or the user explicitly asked for a full review, call `review` again with preview=false and summarize its findings.',
      '3. If the full review returns a background task id, report that id immediately and use `TaskOutput` later instead of leaving the user with no progress.',
      '4. If the scope is very large, report the file count and suggest a narrower `scan` path or review range before starting a long full review.',
      '5. Do not edit files while reviewing.',
    ].join('\n'),
    [
      'Output:',
      '- Summarize the review scope and whether a full review was run.',
      '- Lead with confirmed findings ordered by severity.',
      '- Include concrete file:line references when OpenCodeReview provides them.',
    ].join('\n'),
    instructions ? `Additional review instructions:\n${instructions}` : '',
  ].filter(Boolean).join('\n\n')
}
