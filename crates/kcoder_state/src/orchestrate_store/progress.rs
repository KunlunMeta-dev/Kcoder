use super::*;

impl PlanStore {
    pub fn edit_plan(
        &self,
        work_id: &str,
        expected_revision: u64,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> anyhow::Result<WorkSnapshot> {
        self.mutate(work_id, expected_revision, |plan, work| {
            if old.is_empty() {
                bail!("old text must not be empty");
            }
            let occurrences = plan.matches(old).count();
            if occurrences == 0 {
                bail!("old text was not found in current plan");
            }
            if occurrences > 1 && !replace_all {
                bail!("old text occurs more than once; set replace_all explicitly");
            }
            let updated = if replace_all {
                plan.replace(old, new)
            } else {
                plan.replacen(old, new, 1)
            };
            let before = parse_plan(plan)?;
            let after = parse_plan(&updated)?;
            let before_states = before
                .tasks
                .iter()
                .map(|task| (&task.key, task.completed))
                .collect::<HashMap<_, _>>();
            let after_states = after
                .tasks
                .iter()
                .map(|task| (&task.key, task.completed))
                .collect::<HashMap<_, _>>();
            if before_states != after_states {
                bail!("EditWorkPlan cannot change task checkbox state or task identity");
            }
            for accepted in work.acceptances.keys() {
                let before_line = task_block(plan, accepted)?;
                let after_line = task_block(&updated, accepted)?;
                if before_line != after_line {
                    bail!("accepted task {accepted} must be reopened before editing its body");
                }
            }
            Ok(updated)
        })
    }

    pub fn record_acceptance(
        &self,
        work_id: &str,
        expected_revision: u64,
        acceptance: AcceptanceRecord,
    ) -> anyhow::Result<WorkSnapshot> {
        self.record_acceptances(work_id, expected_revision, vec![acceptance])
    }

    /// Atomically accept one or more tasks using evidence from the same revision.
    ///
    /// Accepting one item creates a new revision. If the caller gathered evidence for
    /// several tasks in one validation wave, submit them together so updating the first
    /// checkbox does not invalidate the rest unnecessarily.
    pub fn record_acceptances(
        &self,
        work_id: &str,
        expected_revision: u64,
        mut acceptances: Vec<AcceptanceRecord>,
    ) -> anyhow::Result<WorkSnapshot> {
        if acceptances.is_empty() {
            bail!("batch acceptance requires at least one task");
        }
        let mut task_keys = std::collections::HashSet::new();
        for acceptance in &acceptances {
            if !task_keys.insert(acceptance.task_key.clone()) {
                bail!(
                    "duplicate task key {} in batch acceptance",
                    acceptance.task_key
                );
            }
            if !(acceptance.works
                && acceptance.conforms
                && acceptance.matches_contract
                && acceptance.honored_boundaries)
            {
                bail!(
                    "all four acceptance checks must be true for task {}",
                    acceptance.task_key
                );
            }
            if acceptance.result_digest.trim().is_empty() || acceptance.evidence_ids.is_empty() {
                bail!(
                    "acceptance for task {} requires a result digest and at least one evidence id",
                    acceptance.task_key
                );
            }
        }

        let evidence_records = self.read_evidence(work_id)?.records;
        let evidence_by_id = evidence_records
            .iter()
            .map(|record| (record.evidence_id.as_str(), record))
            .collect::<HashMap<_, _>>();
        let mut accepted_evidence = HashMap::new();
        for acceptance in &acceptances {
            let mut records = Vec::with_capacity(acceptance.evidence_ids.len());
            for evidence_id in &acceptance.evidence_ids {
                let evidence = evidence_by_id
                    .get(evidence_id.as_str())
                    .with_context(|| format!("unknown evidence id {evidence_id}"))?;
                if evidence.revision != expected_revision {
                    bail!(
                        "evidence {evidence_id} belongs to revision {}, expected {expected_revision}",
                        evidence.revision
                    );
                }
                records.push(*evidence);
            }
            accepted_evidence.insert(acceptance.task_key.clone(), records);
        }
        let now = Utc::now();
        for acceptance in &mut acceptances {
            acceptance.accepted_at = now;
        }
        self.mutate(work_id, expected_revision, move |plan, work| {
            let parsed = parse_plan(plan)?;
            let mut line_indices = HashMap::new();
            for acceptance in &acceptances {
                let key = &acceptance.task_key;
                let task = parsed
                    .task(key)
                    .with_context(|| format!("unknown task key {key}"))?;
                if task.completed {
                    bail!("task {key} is already completed");
                }
                let evidence = &accepted_evidence[key];
                for requirement in &task.evidence_requirements {
                    if !evidence
                        .iter()
                        .any(|record| requirement.matches(&record.evidence))
                    {
                        bail!(
                            "task {key} requires {requirement:?} evidence from the current revision"
                        );
                    }
                }
                line_indices.insert(key.clone(), task.line_index);
            }
            let mut updated_plan = plan.to_string();
            for acceptance in &acceptances {
                let key = acceptance.task_key.clone();
                work.acceptances.insert(key.clone(), acceptance.clone());
                updated_plan = set_checkbox(&updated_plan, line_indices[&key], true)?;
            }
            Ok(updated_plan)
        })
    }

    pub fn reopen_task(
        &self,
        work_id: &str,
        expected_revision: u64,
        task_key: &str,
        reason: &str,
    ) -> anyhow::Result<WorkSnapshot> {
        if reason.trim().is_empty() {
            bail!("reopen reason must not be empty");
        }
        let key = task_key.to_string();
        self.mutate(work_id, expected_revision, move |plan, work| {
            let parsed = parse_plan(plan)?;
            let task = parsed
                .task(&key)
                .with_context(|| format!("unknown task key {key}"))?;
            if !task.completed || work.acceptances.remove(&key).is_none() {
                bail!("task {key} has no acceptance to reopen");
            }
            set_checkbox(plan, task.line_index, false)
        })
    }

    pub fn append_notepad(
        &self,
        work_id: &str,
        name: &str,
        content: &str,
    ) -> anyhow::Result<PathBuf> {
        if !matches!(name, "learnings" | "decisions" | "issues" | "verification") {
            bail!("notepad name must be learnings, decisions, issues, or verification");
        }
        if content.trim().is_empty() {
            bail!("notepad content must not be empty");
        }
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let notes = work_dir.join("notepads");
        create_directory_no_follow(&notes)?;
        let path = notes.join(format!("{name}.md"));
        let mut file = open_append_no_follow(&path)?;
        writeln!(file, "\n{}", content.trim())?;
        file.sync_all()?;
        sync_directory(&notes)?;
        Ok(path)
    }

    pub fn read_notepad_tail(
        &self,
        work_id: &str,
        name: &str,
        max_bytes: usize,
    ) -> anyhow::Result<String> {
        if !matches!(name, "learnings" | "decisions" | "issues" | "verification") {
            bail!("unknown Orchestrate notepad {name}");
        }
        self.read_work(work_id)?;
        let path = self
            .work_dir(work_id)?
            .join("notepads")
            .join(format!("{name}.md"));
        if !path.exists() || max_bytes == 0 {
            return Ok(String::new());
        }
        let content = read_string_no_follow(&path)?;
        Ok(utf8_tail(&content, max_bytes).to_string())
    }
}
