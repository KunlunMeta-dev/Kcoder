//! Immutable publication snapshots sourced from the real Wiki catalog.
mod publications;
pub use publications::{
    OptionalIndexIdentity, PublicationAccess, PublicationAction, PublicationIndexHealth,
    PublicationReferenceResolver, PublicationSourceResolver, VerifiedPublicationSources,
};

mod catalog_read;
pub use catalog_read::{
    CatalogReadCancellation, CatalogReadLimits, CatalogReadProof, ExistingKnowledgeCatalog,
};

mod catalog_write;
pub use catalog_write::OwnedKnowledgeCatalog;

mod table_arithmetic;
pub use table_arithmetic::{calculate_markdown_deadline_facts, calculate_markdown_table_facts};

mod material_inventory;
pub use material_inventory::calculate_markdown_material_inventory;
