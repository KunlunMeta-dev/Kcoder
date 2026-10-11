use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prerequisite {
    PathExists {
        name: String,
        path: std::path::PathBuf,
    },
    Program {
        name: String,
        program: String,
    },
}

impl Prerequisite {
    pub fn path(name: impl Into<String>, path: impl Into<std::path::PathBuf>) -> Self {
        Self::PathExists {
            name: name.into(),
            path: path.into(),
        }
    }

    pub fn program(name: impl Into<String>, program: impl Into<String>) -> Self {
        Self::Program {
            name: name.into(),
            program: program.into(),
        }
    }

    pub fn evaluate(&self) -> PrerequisiteResult {
        match self {
            Self::PathExists { name, path } => PrerequisiteResult {
                name: name.clone(),
                met: path.exists(),
                detail: (!path.exists()).then(|| format!("路径不存在: {}", path.display())),
            },
            Self::Program { name, program } => {
                let found = find_program(program);
                PrerequisiteResult {
                    name: name.clone(),
                    met: found,
                    detail: (!found).then(|| format!("找不到程序: {program}")),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrerequisiteResult {
    pub name: String,
    pub met: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn find_program(program: &str) -> bool {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 {
        return candidate.is_file();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|directory| {
        let path = directory.join(program);
        if path.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            ["exe", "cmd", "bat"]
                .iter()
                .any(|extension| path.with_extension(extension).is_file())
        }
        #[cfg(not(windows))]
        false
    })
}
