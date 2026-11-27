ALTER TABLE libraries ADD COLUMN deleted_at_ms INTEGER CHECK(deleted_at_ms IS NULL OR deleted_at_ms >= 0);
ALTER TABLE libraries ADD COLUMN purge_pending INTEGER NOT NULL DEFAULT 0 CHECK(purge_pending IN (0,1));
ALTER TABLE libraries ADD COLUMN purged_at_ms INTEGER CHECK(purged_at_ms IS NULL OR purged_at_ms >= 0);
CREATE INDEX libraries_lifecycle ON libraries(principal,target,deleted_at_ms,archived,id);
