-- Repair prepared file-contract batches blocked only by empty review markers.
-- Preserve page bytes and their verification findings for the normal commit path.
WITH checked AS (
    SELECT library_id, job_id, after_chunk,
           CASE WHEN json_valid(checkpoint_json) THEN checkpoint_json ELSE '{}' END AS checkpoint,
           CASE WHEN json_valid(publication_json) THEN publication_json ELSE 'null' END AS publication
    FROM knowledge_jobs
    WHERE status = 'awaiting_review' AND error_code = 'review_required' AND pipeline_version = 2
)
UPDATE knowledge_jobs
SET status = 'queued',
    checkpoint_json = json_set(checkpoint_json, '$.proposal.reviewNotes', json('[]')),
    error_code = NULL,
    error_detail = NULL,
    lease_token = NULL,
    lease_until_ms = 0
WHERE (library_id, job_id) IN (
    SELECT candidate.library_id, candidate.job_id
    FROM checked AS candidate
    WHERE json_type(candidate.publication) = 'object'
      AND json_type(candidate.checkpoint, '$.throughChunk') = 'integer'
      AND json_extract(candidate.checkpoint, '$.throughChunk') > candidate.after_chunk
      AND json_type(candidate.checkpoint, '$.hasMoreChunks') IN ('true', 'false')
      AND json_type(candidate.checkpoint, '$.proposal.pages') = 'array'
      AND json_array_length(candidate.checkpoint, '$.proposal.pages') > 0
      AND json_type(candidate.checkpoint, '$.proposal.reviewNotes') = 'array'
      AND json_array_length(candidate.checkpoint, '$.proposal.reviewNotes') > 0
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(candidate.checkpoint, '$.proposal.reviewNotes') AS note
          WHERE note.type <> 'text'
             OR lower(trim(rtrim(trim(note.value), '.。!！'))) NOT IN (
                 '无', '暂无', '无阻断项', '无阻断问题', '没有阻断项',
                 'none', 'no blockers', 'no blocking issues'
             )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM knowledge_commits AS commit_record
          WHERE commit_record.library_id = candidate.library_id
            AND commit_record.request_key = 'wiki-job:' || candidate.job_id || ':' ||
                json_extract(candidate.checkpoint, '$.throughChunk')
      )
);
