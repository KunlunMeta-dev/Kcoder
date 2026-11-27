//! Isolated JavaScript nodes: no host functions, filesystem, network, shell or agents.
use anyhow::{Context as _, Result, bail, ensure};
use kcoder_types::workflow::WorkflowCodeConfig;
use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub(crate) fn validate_source(source: &str) -> Result<()> {
    validate_parameters(source, "input,nodes")
}
pub(crate) fn validate_bound_source(source: &str) -> Result<()> {
    validate_parameters(source, "input,nodes,bindings")
}
pub(crate) fn validate_result_check(source: &str) -> Result<()> {
    validate_parameters(source, "input,nodes,bindings,result")?;
    // An expression statement (including a standalone function) can compile
    // as a function body while discarding its value and returning undefined.
    let trimmed = source.trim().trim_end_matches(';').trim();
    let runtime = Runtime::new()?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let context = Context::full(&runtime)?;
    let standalone = context.with(|ctx| {
        rquickjs::Module::declare(
            ctx,
            "check-expression",
            format!("export default ({trimmed});"),
        )
        .is_ok()
    });
    ensure!(
        !standalone,
        "workflow_verification: resultCheck.source must be a function BODY with a top-level return, not an unused expression/function declaration; remove the outer function wrapper and return a boolean"
    );
    Ok(())
}
fn validate_parameters(source: &str, parameters: &str) -> Result<()> {
    ensure!(
        source.len() <= 64 * 1024,
        "workflow_code: source exceeds 64 KiB"
    );
    let runtime = Runtime::new()?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);
    let context = Context::full(&runtime)?;
    context.with(|ctx| {
        rquickjs::Module::declare(
            ctx.clone(),
            "workflow-code-check",
            format!("export default function({parameters}){{\n{source}\n}}"),
        )
        .map(|_| ())
        .map_err(|error| {
            anyhow::anyhow!(
                "workflow_code: invalid JavaScript: {}",
                rquickjs::CaughtError::from_error(&ctx, error)
                    .to_string()
                    .chars()
                    .take(1024)
                    .collect::<String>()
            )
        })
    })
}

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(crate) async fn execute(
    code: WorkflowCodeConfig,
    context: Value,
    parent: CancellationToken,
    memory: usize,
    stack: usize,
    result_check: bool,
) -> Result<Value> {
    ensure!(
        code.source.len() <= 64 * 1024 && (1..=10_000).contains(&code.timeout_ms),
        "workflow_code: invalid limits"
    );
    // Existing Code bodies may declare local variables named result/bindings.
    // Only opt into the new parameters when that node uses the new contract.
    let parameters = if result_check {
        "input,nodes,bindings,result"
    } else if context.get("bindings").is_some() {
        "input,nodes,bindings"
    } else {
        "input,nodes"
    };
    let cancellation = parent.child_token();
    let _guard = CancelOnDrop(cancellation.clone());
    let input = serde_json::to_string(&serde_json::to_string(&context)?)?;
    let work = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value> {
        if work.is_cancelled() {
            bail!("workflow_code: cancelled");
        }
        let runtime = Runtime::new().context("workflow_code: create runtime")?;
        runtime.set_memory_limit(memory);
        runtime.set_max_stack_size(stack);
        let deadline = Instant::now() + Duration::from_millis(code.timeout_ms);
        let interrupt = work.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupt.is_cancelled() || Instant::now() >= deadline
        })));
        let js = Context::full(&runtime).context("workflow_code: create context")?;
        let script = format!(
            r#"(() => {{
            'use strict';
            const context = JSON.parse({input});
            const result = (function({parameters}) {{ 'use strict';
                {source}
            }})(context.input, context.nodes, context.bindings, context.result);
            function validate(value, seen = new Set()) {{
                if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
                if (typeof value === 'number' && Number.isFinite(value)) return;
                if (typeof value !== 'object' || value instanceof Promise || seen.has(value)) throw new Error('code must return finite, acyclic JSON data');
                if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('code must return plain JSON objects');
                seen.add(value);
                for (const key of Object.keys(value)) validate(value[key], seen);
                seen.delete(value);
            }}
            validate(result);
            return JSON.stringify(result);
        }})()"#,
            source = code.source
        );
        let encoded = js.with(|ctx| {
            ctx.eval::<String, _>(script).map_err(|error| {
                rquickjs::CaughtError::from_error(&ctx, error)
                    .to_string()
                    .chars()
                    .take(1024)
                    .collect::<String>()
            })
        });
        if work.is_cancelled() {
            bail!("workflow_code: cancelled");
        }
        if Instant::now() >= deadline {
            bail!(
                "workflow_code: execution timed out after {} ms",
                code.timeout_ms
            );
        }
        let encoded = encoded.map_err(|error| {
            anyhow::anyhow!("workflow_code: JavaScript execution failed: {error}")
        })?;
        ensure!(
            encoded.len() <= crate::graph_data::MAX_VALUE_BYTES,
            "workflow_code: output exceeds size limit"
        );
        let value =
            serde_json::from_str(&encoded).context("workflow_code: result must be JSON data")?;
        crate::graph_data::bounded_value(&value, crate::graph_data::MAX_VALUE_BYTES)?;
        Ok(value)
    });
    tokio::select! {
        _ = cancellation.cancelled() => bail!("workflow_code: cancelled"),
        result = result => result.context("workflow_code: runtime worker failed")?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    async fn run(source: &str, timeout_ms: u64) -> Result<Value> {
        execute(
            WorkflowCodeConfig {
                source: source.into(),
                timeout_ms,
            },
            json!({"input":{"values":[3,1,2]},"nodes":{"prior":{"bonus":5}}}),
            CancellationToken::new(),
            16 * 1024 * 1024,
            512 * 1024,
            false,
        )
        .await
    }
    #[test]
    fn result_check_rejects_uncalled_functions_and_discarded_expressions() {
        for source in [
            "function check(input,nodes,bindings,result){ return true; }",
            "() => true",
            "result.count === 3",
        ] {
            assert!(validate_result_check(source).is_err(), "{source}");
        }
        validate_result_check("function check(value){return value.ok;} return check(result);")
            .unwrap();
        validate_result_check("return result.count === 3;").unwrap();
    }
    #[tokio::test]
    async fn computes_from_input_and_upstream_without_host_capabilities() {
        assert_eq!(
            run(
                "const result = {ok:true}; const bindings = 2; return result;",
                1000
            )
            .await
            .unwrap(),
            json!({"ok":true})
        );
        assert_eq!(run("return {sorted: input.values.sort(), total: input.values.reduce((a,b)=>a+b,0)+nodes.prior.bonus};",1000).await.unwrap(), json!({"sorted":[1,2,3],"total":11}));
        assert_eq!(
            run(
                "return [typeof fetch, typeof process, typeof require, typeof agent];",
                1000
            )
            .await
            .unwrap(),
            json!(["undefined", "undefined", "undefined", "undefined"])
        );
    }
    #[tokio::test]
    async fn rejects_non_json_and_interrupts_infinite_loops() {
        for source in [
            "return undefined;",
            "return NaN;",
            "return Promise.resolve(1);",
            "const x={};x.x=x;return x;",
            "return new Date();",
        ] {
            assert!(run(source, 1000).await.is_err(), "{source}");
        }
        assert!(
            run("while(true) {}", 20)
                .await
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
    }
    #[tokio::test]
    async fn cancelled_code_never_starts() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(
            execute(
                WorkflowCodeConfig {
                    source: "return 1;".into(),
                    timeout_ms: 1000
                },
                json!({}),
                token,
                16 * 1024 * 1024,
                512 * 1024,
                false,
            )
            .await
            .is_err()
        );
    }
}
