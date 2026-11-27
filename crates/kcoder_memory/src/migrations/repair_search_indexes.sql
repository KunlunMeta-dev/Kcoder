CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts USING fts5(
    observation_id UNINDEXED,
    project_key UNINDEXED,
    title,
    subtitle,
    narrative,
    facts,
    concepts,
    tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_summaries_fts USING fts5(
    summary_id UNINDEXED,
    project_key UNINDEXED,
    session_id UNINDEXED,
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes,
    tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_observations_ai
    AFTER INSERT ON memory_observations
BEGIN
    INSERT INTO memory_observations_fts(
        rowid, observation_id, project_key, title, subtitle, narrative, facts, concepts
    )
    VALUES (
        new.id,
        new.id,
        new.project_key,
        COALESCE(new.title, ''),
        COALESCE(new.subtitle, ''),
        COALESCE(new.narrative, ''),
        COALESCE(new.facts_json, ''),
        COALESCE(new.concepts_json, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS memory_observations_ad
    AFTER DELETE ON memory_observations
BEGIN
    DELETE FROM memory_observations_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_observations_au
    AFTER UPDATE ON memory_observations
BEGIN
    DELETE FROM memory_observations_fts WHERE rowid = old.id;
    INSERT INTO memory_observations_fts(
        rowid, observation_id, project_key, title, subtitle, narrative, facts, concepts
    )
    VALUES (
        new.id,
        new.id,
        new.project_key,
        COALESCE(new.title, ''),
        COALESCE(new.subtitle, ''),
        COALESCE(new.narrative, ''),
        COALESCE(new.facts_json, ''),
        COALESCE(new.concepts_json, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS memory_summaries_ai
    AFTER INSERT ON memory_summaries
BEGIN
    INSERT INTO memory_summaries_fts(
        rowid, summary_id, project_key, session_id, request,
        investigated, learned, completed, next_steps, notes
    )
    VALUES (
        new.id,
        new.id,
        new.project_key,
        new.session_id,
        COALESCE(new.request, ''),
        COALESCE(new.investigated, ''),
        COALESCE(new.learned, ''),
        COALESCE(new.completed, ''),
        COALESCE(new.next_steps, ''),
        COALESCE(new.notes, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS memory_summaries_ad
    AFTER DELETE ON memory_summaries
BEGIN
    DELETE FROM memory_summaries_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_summaries_au
    AFTER UPDATE ON memory_summaries
BEGIN
    DELETE FROM memory_summaries_fts WHERE rowid = old.id;
    INSERT INTO memory_summaries_fts(
        rowid, summary_id, project_key, session_id, request,
        investigated, learned, completed, next_steps, notes
    )
    VALUES (
        new.id,
        new.id,
        new.project_key,
        new.session_id,
        COALESCE(new.request, ''),
        COALESCE(new.investigated, ''),
        COALESCE(new.learned, ''),
        COALESCE(new.completed, ''),
        COALESCE(new.next_steps, ''),
        COALESCE(new.notes, '')
    );
END;

-- Derived indexes can be absent or incomplete after restoring
-- a database. Preserve source rows and rebuild only missing
-- observation entries, just as for summaries below.
INSERT INTO memory_observations_fts(
    rowid, observation_id, project_key, title, subtitle, narrative, facts, concepts
)
SELECT
    o.id, o.id, o.project_key,
    COALESCE(o.title, ''), COALESCE(o.subtitle, ''),
    COALESCE(o.narrative, ''), COALESCE(o.facts_json, ''),
    COALESCE(o.concepts_json, '')
FROM memory_observations o
WHERE NOT EXISTS (
    SELECT 1 FROM memory_observations_fts f WHERE f.rowid = o.id
);

INSERT INTO memory_summaries_fts(
    rowid, summary_id, project_key, session_id, request,
    investigated, learned, completed, next_steps, notes
)
SELECT
    s.id,
    s.id,
    s.project_key,
    s.session_id,
    COALESCE(s.request, ''),
    COALESCE(s.investigated, ''),
    COALESCE(s.learned, ''),
    COALESCE(s.completed, ''),
    COALESCE(s.next_steps, ''),
    COALESCE(s.notes, '')
FROM memory_summaries s
WHERE NOT EXISTS (
    SELECT 1 FROM memory_summaries_fts f WHERE f.rowid = s.id
);
