"""Populate an already-owned catalog with model-independent UI fixtures."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import uuid

root = Path(sys.argv[1]).resolve()
assert root.name == 'kcoder-home' and 'state' in root.parts
database = root / 'knowledge/state.sqlite'
with sqlite3.connect(database) as connection:
    if len(sys.argv) > 2 and sys.argv[2] == 'summary':
        print(json.dumps({
            'modelCalls': connection.execute('SELECT count(*) FROM knowledge_job_calls').fetchone()[0],
            'humanVersions': connection.execute("SELECT count(*) FROM knowledge_page_revisions WHERE author='human'").fetchone()[0],
            'restoredVersions': connection.execute('SELECT count(*) FROM knowledge_page_revisions WHERE restored_from IS NOT NULL').fetchone()[0],
        }))
        sys.exit(0)
    library, = connection.execute('SELECT id FROM libraries WHERE name=?', ('Owned receipts',)).fetchone()
    objects = database.with_suffix('.objects') / library
    objects.mkdir(mode=0o700, parents=True, exist_ok=True)
    def put(text):
        digest = hashlib.sha256(text.encode()).hexdigest()
        (objects / (digest + '.md')).write_text(text)
        return digest
    source, source_revision = str(uuid.uuid4()), str(uuid.uuid4())
    text = 'Owned receipt evidence.'
    connection.execute('INSERT INTO knowledge_sources VALUES(?,?,?,?,?,?)', (library, source, source_revision, 'owned-source', 'Owned source', put(text)))
    connection.execute('INSERT INTO knowledge_source_lifecycle VALUES(?,?,?,0)', (library, source, source_revision))
    connection.execute('INSERT INTO knowledge_chunks(library_id,source_id,revision_id,chunk_id,ordinal,first_line,last_line,text) VALUES(?,?,?,?,0,1,1,?)', (library, source, source_revision, 'owned-chunk', text))
    pages = {'A': str(uuid.uuid4()), 'B': str(uuid.uuid4())}
    citation = json.dumps([{'sourceId': source, 'revisionId': source_revision, 'chunkId': 'owned-chunk', 'quote': text}])
    for label, page in pages.items():
        revision = str(uuid.uuid4())
        title, body = 'Owned ' + label, 'Receipt page ' + label + '.\n\n' + text
        connection.execute('INSERT INTO knowledge_page_revisions(library_id,page_id,revision_id,title,kind,body_hash,citations_json,related_json,revision_sequence) VALUES(?,?,?,?,?,?,?,?,1)', (library, page, revision, title, '"concept"', put(body), citation, json.dumps([pages['B' if label == 'A' else 'A']])))
        connection.execute('INSERT INTO knowledge_pages VALUES(?,?,?,0)', (library, page, revision))
        connection.execute('INSERT INTO knowledge_fts VALUES(?,?,?,?,?,?,?)', (library, page, revision, title, body, 'owned ' + label.lower(), 'receipt page ' + label.lower() + ' owned receipt evidence'))
    assert connection.execute('SELECT count(*) FROM knowledge_job_calls').fetchone()[0] == 0
    print(json.dumps({'libraryId': library, 'pages': pages, 'modelCalls': 0}))
