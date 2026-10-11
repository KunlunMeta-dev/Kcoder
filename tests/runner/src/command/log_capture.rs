use anyhow::{Context, Result};
use kcoder_test_harness::StreamingRedactor;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

#[derive(Debug)]
pub(super) struct LogCapture {
    workers: Vec<JoinHandle<Result<()>>>,
    paths: Vec<PathBuf>,
}

impl LogCapture {
    pub(super) fn start(
        stdout_redactor: StreamingRedactor,
        stdout: impl Read + Send + 'static,
        stdout_path: &Path,
        stderr_redactor: StreamingRedactor,
        stderr: impl Read + Send + 'static,
        stderr_path: &Path,
    ) -> Result<Self> {
        let stdout_writer = File::create(stdout_path)
            .with_context(|| format!("创建 suite 日志失败: {}", stdout_path.display()))?;
        let stderr_writer = match File::create(stderr_path) {
            Ok(writer) => writer,
            Err(error) => {
                let _ = fs::remove_file(stdout_path);
                return Err(error)
                    .with_context(|| format!("创建 suite 日志失败: {}", stderr_path.display()));
            }
        };
        let workers = vec![
            spawn_log_worker(
                stdout,
                stdout_path.to_path_buf(),
                stdout_redactor,
                stdout_writer,
            ),
            spawn_log_worker(
                stderr,
                stderr_path.to_path_buf(),
                stderr_redactor,
                stderr_writer,
            ),
        ];
        Ok(Self {
            workers,
            paths: vec![stdout_path.to_path_buf(), stderr_path.to_path_buf()],
        })
    }

    pub(super) fn finalize(&mut self) -> Result<()> {
        let mut failure = None;
        for worker in self.workers.drain(..) {
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    failure.get_or_insert(error);
                }
                Err(_) => {
                    failure.get_or_insert_with(|| anyhow::anyhow!("suite 日志线程 panic"));
                }
            }
        }
        if let Some(error) = failure {
            self.delete_all();
            Err(error)
        } else {
            Ok(())
        }
    }

    pub(super) fn poll_finished(&mut self) -> Result<()> {
        let mut failure = None;
        let mut index = 0;
        while index < self.workers.len() {
            if !self.workers[index].is_finished() {
                index += 1;
                continue;
            }
            let worker = self.workers.swap_remove(index);
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    failure.get_or_insert(error);
                }
                Err(_) => {
                    failure.get_or_insert_with(|| anyhow::anyhow!("suite 日志线程 panic"));
                }
            }
        }
        if let Some(error) = failure {
            self.delete_all();
            Err(error)
        } else {
            Ok(())
        }
    }

    fn delete_all(&self) {
        self.paths.iter().for_each(|path| {
            let _ = fs::remove_file(path);
        });
    }
}

impl Drop for LogCapture {
    fn drop(&mut self) {
        if self.finalize().is_err() {
            self.delete_all();
        }
    }
}

fn spawn_log_worker(
    mut reader: impl Read + Send + 'static,
    path: PathBuf,
    mut redactor: StreamingRedactor,
    mut writer: File,
) -> JoinHandle<Result<()>> {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .with_context(|| format!("读取 suite 日志流失败: {}", path.display()))?;
            if count == 0 {
                break;
            }
            writer
                .write_all(redactor.push(&buffer[..count]).as_bytes())
                .with_context(|| format!("写入脱敏 suite 日志失败: {}", path.display()))?;
        }
        writer
            .write_all(redactor.finish().as_bytes())
            .with_context(|| format!("完成脱敏 suite 日志失败: {}", path.display()))?;
        writer.flush()?;
        Ok(())
    })
}
