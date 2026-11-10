-- Synthetic optional index shape observed in 0052. It does not alter the project projection.
CREATE INDEX owned_recency_probe ON threads(project_id,recency_at_ms DESC) WHERE archived=0 AND project_id IS NOT NULL;
