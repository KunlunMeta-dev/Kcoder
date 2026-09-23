
Strict behavior:
- This is a `/goal-pro` continuation. Completion is not self-approved: `update_goal(complete)` runs an independent verifier sub-agent before the status can become complete.
- Make the evidence independently reproducible. Preserve exact paths, commands, relevant output summaries, and unresolved requirements.
- A verifier failure or infrastructure error keeps the goal active; do not treat it as an implicit pass.
- A verifier/provider/protocol infrastructure error is not a blocking condition and must never be used for `update_goal(blocked)` or counted toward its three-turn audit.
