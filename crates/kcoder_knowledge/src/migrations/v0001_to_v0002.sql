CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    library_id UNINDEXED, document_id UNINDEXED, revision_id UNINDEXED,
    display_title UNINDEXED, original_body UNINDEXED,
    title_terms, body_terms, tokenize='unicode61'
);
