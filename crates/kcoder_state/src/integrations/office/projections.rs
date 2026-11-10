use super::*;
impl OfficeStore {
    pub fn save_projection(
        &self,
        operation: &str,
        projection: OfficeContextProjection,
    ) -> Result<OfficeContextProjection> {
        projection.validate()?;
        ensure!(projection.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let key = reference_key(&OfficeArtifactRef {
            id: projection.id.clone(),
            revision: projection.revision,
        });
        self.mutate(operation, "context.saveProjection", &projection, |state| {
            if let Some(previous) = state.projections.get(&key) {
                ensure!(previous == &projection, "OFFICE_PROJECTION_IMMUTABLE");
                return Ok(previous.clone());
            }
            ensure!(state.projections.len() < 256, "OFFICE_PROJECTION_CAPACITY");
            state.projections.insert(key, projection.clone());
            Ok(projection.clone())
        })
    }
    pub fn read_projection(
        &self,
        reference: &OfficeArtifactRef,
    ) -> Result<Option<OfficeContextProjection>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        let projection = self
            .load()?
            .projections
            .get(&reference_key(reference))
            .cloned();
        if let Some(projection) = &projection {
            projection.validate()?;
            ensure!(projection.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        }
        Ok(projection)
    }
}
