import * as C from '../../../../shared/generated/contracts';
import { PROJECTS_CAPABILITY, PROJECTS_METHODS } from '../../../../shared/migrationProjects';
export interface ProjectsCalls {
  projectsDiscover: [C.MigrationProjectsDiscoverParams,C.MigrationProjectSourcesResult];
  projectsSources: [C.MigrationProjectsSourcesParams,C.MigrationProjectSourcesResult];
  projectSourceRoots: [C.MigrationProjectSourceRootsParams,C.MigrationProjectSourceRootsResult];
  projectTargets: [C.MigrationProjectTargetsParams,C.MigrationProjectTargetsResult];
  projectTargetRoots: [C.MigrationProjectTargetRootsParams,C.MigrationProjectTargetRootsResult];
  projectReport: [C.MigrationProjectReportParams,C.MigrationProjectReportResult];
}
const rule = (method: string, params: (v: unknown)=>boolean, result: (v: unknown)=>boolean, rows: string[]) => ({method,caps:[PROJECTS_CAPABILITY],read:true,params,result,rows});
export const PROJECTS_CALLS = {
  projectsDiscover: rule(PROJECTS_METHODS.discover,C.isMigrationProjectsDiscoverParams,C.isMigrationProjectSourcesResult,['items']),
  projectsSources: rule(PROJECTS_METHODS.sources,C.isMigrationProjectsSourcesParams,C.isMigrationProjectSourcesResult,['items']),
  projectSourceRoots: rule(PROJECTS_METHODS.sourceRoots,C.isMigrationProjectSourceRootsParams,C.isMigrationProjectSourceRootsResult,['roots']),
  projectTargets: rule(PROJECTS_METHODS.targets,C.isMigrationProjectTargetsParams,C.isMigrationProjectTargetsResult,['items']),
  projectTargetRoots: rule(PROJECTS_METHODS.targetRoots,C.isMigrationProjectTargetRootsParams,C.isMigrationProjectTargetRootsResult,['roots']),
  projectReport: rule(PROJECTS_METHODS.report,C.isMigrationProjectReportParams,C.isMigrationProjectReportResult,['fields']),
};
