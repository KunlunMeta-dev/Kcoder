Answer verification:
- Before calling `update_goal` with status `complete`, write the final report to `{report_path}`.
- Keep the report at or below 32 KiB of valid UTF-8. It must directly answer the objective and give reproducible file paths, commands, or sources for important claims.
- The verifier reads that exact report, records its SHA-256 digest, and rejects completion if the report is missing, empty, unsafe, oversized, or changes during verification.
