use super::*;

impl Guide {
    pub(in crate::migration_cli::transfer::guide) async fn preview_source_instructions(
        &self,
        session: &MigrationSourceSessionParams,
        id: &str,
    ) -> Result<()> {
        let mut page = 0;
        loop {
            let params = MigrationSourceInstructionPageParams {
                capture_id: id.into(),
                page_index: page,
            };
            let result: MigrationInstructionPageResult = self
                .source_query(session, "instructions_page", &params)
                .await?;
            super::super::super::instructions::page(&result, &params)?;
            self.io.state("instruction_report", &result)?;
            let answer = self.io.ask("transfer_instruction_preview", "本页最多10项；original N 原文、compiled N 固定编译正文、next/prev翻页、back返回。查看不启用内容，未知语义不按普通指令迁入。", json!({"page":page,"hasNextPage":result.next_page.is_some()}), Some("back"))?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "back" => return Ok(()),
                "next" if result.next_page.is_some() => page = result.next_page.unwrap(),
                "prev" if page > 0 => page -= 1,
                verb @ ("original" | "compiled") => {
                    let item = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                        .ok_or_else(|| anyhow::anyhow!("migration_transfer_invalid_selection"))?;
                    let representation = if verb == "compiled" {
                        InstructionRepresentation::Compiled
                    } else {
                        InstructionRepresentation::Original
                    };
                    let mut offset = 0;
                    let mut identity = None;
                    loop {
                        let request = MigrationSourceInstructionBodyParams {
                            capture_id: id.into(),
                            item_id: item.item_id.clone(),
                            representation,
                            offset,
                        };
                        let body: MigrationInstructionBodyResult = self
                            .source_query(session, "instructions_body", &request)
                            .await?;
                        super::super::super::instructions::body(&body, &request)?;
                        let observed =
                            (body.sha256.clone(), body.total_bytes, body.format_revision);
                        ensure!(
                            identity
                                .as_ref()
                                .is_none_or(|previous| previous == &observed),
                            "migration_instruction_preview_changed"
                        );
                        identity = Some(observed);
                        self.io.state("instruction_body", &body)?;
                        let Some(next) = body.next_offset else {
                            break;
                        };
                        if !self
                            .io
                            .yes("instruction_next_body", "是否明确读取同一正文的下一段？")?
                        {
                            break;
                        }
                        offset = next;
                    }
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前页编号或有效操作。",
                )?,
            }
        }
    }

    pub(in crate::migration_cli::transfer::guide) async fn instruction_page(
        &self,
        client: &mut runtime::Client,
        target: &MigrationInstructionReadTarget,
        page_index: u32,
    ) -> Result<MigrationInstructionPageResult> {
        let request = MigrationInstructionPageParams {
            target: target.clone(),
            page_index,
        };
        let page: MigrationInstructionPageResult = self
            .rpc(client, method::MIGRATION_INSTRUCTION_PAGE, &request)
            .await?;
        super::super::super::instructions::page_target(&page, &request)?;
        Ok(page)
    }

    pub(super) async fn target_body(
        &self,
        client: &mut runtime::Client,
        target: &MigrationInstructionReadTarget,
        item_id: &str,
        representation: InstructionRepresentation,
    ) -> Result<()> {
        let mut offset = 0;
        let mut identity = None;
        loop {
            let request = MigrationInstructionBodyParams {
                target: target.clone(),
                item_id: item_id.into(),
                representation,
                offset,
            };
            let result: MigrationInstructionBodyResult = self
                .rpc(client, method::MIGRATION_INSTRUCTION_BODY, &request)
                .await?;
            super::super::super::instructions::body_target(&result, &request)?;
            let observed = (
                result.sha256.clone(),
                result.total_bytes,
                result.format_revision,
            );
            ensure!(
                identity
                    .as_ref()
                    .is_none_or(|previous| previous == &observed),
                "migration_instruction_preview_changed"
            );
            identity = Some(observed);
            self.io.state("instruction_body", &result)?;
            let Some(next) = result.next_offset else {
                return Ok(());
            };
            if !self
                .io
                .yes("instruction_next_body", "是否明确读取同一正文的下一段？")?
            {
                return Ok(());
            }
            offset = next;
        }
    }

    pub(in crate::migration_cli::transfer::guide) async fn saved_instructions(
        &self,
        client: &mut runtime::Client,
        job: &str,
    ) -> Result<()> {
        client.require(CAPABILITY_MIGRATION_INSTRUCTION_SOURCES_V1)?;
        let target = MigrationInstructionReadTarget::Job { job_id: job.into() };
        let mut page = 0;
        loop {
            let result = self.instruction_page(client, &target, page).await?;
            self.io.state("instruction_report", &result)?;
            let answer=self.io.ask("transfer_instruction_saved","原批次静态快照：original N原文、compiled N编译正文、next/prev、back。来源移走仍读取原记录，不扫描新来源、不启用。",json!({"page":page,"hasNextPage":result.next_page.is_some()}),Some("back"))?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "back" => return Ok(()),
                "next" if result.next_page.is_some() => page = result.next_page.unwrap(),
                "prev" if page > 0 => page -= 1,
                verb @ ("original" | "compiled") => {
                    let item = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                        .ok_or_else(|| anyhow::anyhow!("migration_transfer_invalid_selection"))?;
                    self.target_body(
                        client,
                        &target,
                        &item.item_id,
                        if verb == "compiled" {
                            InstructionRepresentation::Compiled
                        } else {
                            InstructionRepresentation::Original
                        },
                    )
                    .await?;
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请选择当前页正文或有效页。",
                )?,
            }
        }
    }
}
