//! Target-side Wiki catalog, archives, and durable job execution.

#[path = "publication_reader/mod.rs"]
pub mod publication_reader;

#[path = "../../app_server/knowledge_archive.rs"]
pub mod knowledge_archive;
#[path = "../../app_server/knowledge_archive_owner.rs"]
mod knowledge_archive_owner;
#[path = "../../app_server/knowledge_requests.rs"]
pub mod knowledge_requests;

pub use knowledge_archive_owner::scavenge as scavenge_archive_staging;

#[path = "../../app_server/knowledge_job_runner.rs"]
pub mod knowledge_job_runner;

#[path = "../../app_server/knowledge_job_scheduler.rs"]
pub mod knowledge_job_scheduler;

#[path = "../../app_server/knowledge_model.rs"]
pub mod knowledge_model;

#[path = "../../app_server/knowledge_model_admission.rs"]
pub mod knowledge_model_admission;

#[path = "../../app_server/knowledge_organization_budget.rs"]
mod knowledge_organization_budget;

#[path = "../../app_server/knowledge_worker_authority.rs"]
pub mod knowledge_worker_authority;

#[path = "../../app_server/knowledge_image_budget.rs"]
mod knowledge_image_budget;

#[path = "../../app_server/knowledge_image_imports.rs"]
pub mod knowledge_image_imports;

#[path = "../../app_server/knowledge_worker.rs"]
pub mod knowledge_worker;

#[path = "../../app_server/knowledge_worker_model.rs"]
pub mod knowledge_worker_model;
