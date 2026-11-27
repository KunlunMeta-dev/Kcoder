-- Synthetic table subset matching the observed 0049 project fields; not vendor SQL execution.
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL);
CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position));
CREATE TABLE threads(id TEXT,project_id TEXT,archived INTEGER,recency_at_ms INTEGER);
INSERT INTO projects VALUES('owned-project','Static project','{"ignored":"not authority"}',0,1,2);
INSERT INTO project_roots VALUES('owned-project',0,'/unopened-source-worktree');
