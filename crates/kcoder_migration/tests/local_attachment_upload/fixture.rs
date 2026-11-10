use super::*;
pub(crate) struct Fixture {
    pub(crate) root: tempfile::TempDir,
    pub(crate) profile: PathBuf,
    pub(crate) selection: HistoricalAttachmentSelection,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        Self::source(MigrationSourceKind::ClaudeCode, false)
    }
    pub(crate) fn source(kind: MigrationSourceKind, tool: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        let source = root.path().join("source");
        PrivateDirectory::open_or_create(&source).unwrap();
        let attachment = if kind == MigrationSourceKind::ClaudeCode {
            json!({"type":"file","filename":"original.bin","path":"/NEVER_AUTHORIZED/original.bin","media_type":"application/octet-stream"})
        } else {
            json!({"type":"input_file","filename":"original.bin","file_path":"C:\\NEVER_AUTHORIZED\\original.bin","media_type":"application/octet-stream"})
        };
        let records = if kind == MigrationSourceKind::ClaudeCode {
            let content = if tool {
                json!([{"type":"tool_result","tool_use_id":"old","content":[attachment]}])
            } else {
                json!([attachment])
            };
            vec![
                json!({"type":"user","uuid":"entry","sessionId":"session","version":"2.1.301","message":{"role":"user","content":content}}),
            ]
        } else {
            vec![
                json!({"type":"session_meta","payload":{"id":"session","cli_version":"0.163.0"}}),
                if tool {
                    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old","output":[attachment]}})
                } else {
                    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[attachment]}})
                },
            ]
        };
        fs::write(
            source.join("fixture.jsonl"),
            records
                .into_iter()
                .map(|value| format!("{value}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let binding = HistorySourceBinding::capture(
            &source,
            Path::new("fixture.jsonl"),
            ExternalHistoryOrigin {
                source: kind,
                source_instance: "owned-upload-fixture".into(),
                source_session_id: "session".into(),
                source_artifact_id: None,
                source_format: "jsonl".into(),
                adapter_revision: "raw/1".into(),
                title: None,
                created_at: None,
                updated_at: None,
                project: None,
                archived: false,
                parent_session_id: None,
            },
            &mut |_, _| true,
        )
        .unwrap();
        let jobs = HistoryJobStore::open(&profile).unwrap();
        let job_id = key();
        let mut job = jobs.create(&job_id, &binding).unwrap();
        while job.stage != HistoryImportStage::Normalized {
            job = jobs.step(&job_id, job.sequence, 10, |_| true).unwrap();
            assert!(!matches!(
                job.stage,
                HistoryImportStage::Failed | HistoryImportStage::Cancelled
            ));
        }
        let position = if kind == MigrationSourceKind::Codex {
            1
        } else {
            0
        };
        if tool {
            HistoryToolAttachments::open_with_revision(
                jobs.archive_reader(&job_id).unwrap(),
                position,
                0,
                None,
                &jobs.normalization_revision(&job_id).unwrap(),
            )
            .unwrap()
            .build(|_, _| true)
            .unwrap();
        }
        Self {
            root,
            profile,
            selection: HistoricalAttachmentSelection {
                job_id,
                view_id: None,
                position,
                block_index: 0,
                tool_item_index: tool.then_some(0),
            },
        }
    }
    pub(crate) fn uploads(&self) -> HistoryLocalAttachmentUploads {
        HistoryLocalAttachmentUploads::open(&self.profile).unwrap()
    }
    pub(crate) fn op(&self, id: &str) -> PathBuf {
        self.profile
            .join("migrations/local-attachment-uploads")
            .join(id)
    }
    pub(crate) fn fill(&self, id: &str, data: &[u8]) -> HistoricalLocalAttachmentUpload {
        let uploads = self.uploads();
        let prepared = uploads.prepare(id, &self.selection, |_| true).unwrap();
        let mut state = uploads
            .begin(
                id,
                prepared.sequence,
                "replacement.bin",
                data.len() as u64,
                &sha(data),
            )
            .unwrap();
        for (index, part) in data
            .chunks(HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize)
            .enumerate()
        {
            state = uploads
                .part(id, state.sequence, index as u32, part)
                .unwrap();
        }
        state
    }
}
