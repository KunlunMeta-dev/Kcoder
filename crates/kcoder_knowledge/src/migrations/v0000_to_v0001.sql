CREATE TABLE libraries (
    id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    target TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    request_key TEXT NOT NULL,
    UNIQUE(principal, target, request_key)
);
CREATE INDEX libraries_scope ON libraries(principal, target, id);
