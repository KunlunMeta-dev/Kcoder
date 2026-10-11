ALTER TABLE knowledge_page_revisions ADD COLUMN revision_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_page_revisions ADD COLUMN author TEXT NOT NULL DEFAULT 'model';
ALTER TABLE knowledge_page_revisions ADD COLUMN restored_from TEXT;
WITH numbered AS (
 SELECT rowid AS id, row_number() OVER(PARTITION BY library_id,page_id ORDER BY rowid) AS seq
 FROM knowledge_page_revisions
)
UPDATE knowledge_page_revisions SET revision_sequence=(SELECT seq FROM numbered WHERE numbered.id=knowledge_page_revisions.rowid);
CREATE UNIQUE INDEX knowledge_page_sequence ON knowledge_page_revisions(library_id,page_id,revision_sequence);
PRAGMA user_version=8;
