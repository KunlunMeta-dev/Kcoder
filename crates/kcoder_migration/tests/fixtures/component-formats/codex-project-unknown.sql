-- Unsupported column type must not become a complete empty project inventory.
CREATE TABLE projects(id TEXT,name TEXT,position TEXT,created_at_ms INTEGER,updated_at_ms INTEGER);
CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
