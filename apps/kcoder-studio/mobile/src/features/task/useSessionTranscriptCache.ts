import { useEffect, useRef, useState } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { useCacheProfileReadable } from "./useCacheProfileReadable";
import { cachedSessionMatches, cacheProfileReadable, SessionCacheCoordinator, type CachedSession } from "./session-cache-coordinator";
import type { ThreadPresenceObservation } from "@/runtime/task-runtime/thread-presence";
import type { WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey } from "@/storage/session-transcript-scope";

function sameVersion(left: { epoch: string; dataRevision: number } | null | undefined,
  right: { epoch: string; dataRevision: number } | null | undefined): boolean {
  return Boolean(left && right && left.epoch === right.epoch && left.dataRevision === right.dataRevision);
}

function presenceProofKey(observation: ThreadPresenceObservation | null | undefined): string | null {
  if (!observation?.scope || observation.result.status !== "absent") return null;
  return JSON.stringify([sessionTranscriptScopeKey(observation.scope), observation.result.threadId,
    observation.result.reason, observation.version?.epoch ?? null, observation.version?.dataRevision ?? null]);
}

export function useSessionTranscriptCache(input: {
  profile: GatewayProfile | null; server?: KCoderServer; serverId: string; threadId: string; cwd?: string;
  enabled: boolean; reauthorizationRequired: boolean; task: TaskRuntime | null; presence?: ThreadPresenceObservation | null;
  workspacePresence?: WorkspacePresenceObservation | null;
}) {
  const identity = input.profile ? profileAuthorizationScopeKey(input.profile) : null;
  let transcriptScopeKey: string | null = null;
  if (input.profile && input.server && input.cwd) {
    try { transcriptScopeKey = sessionTranscriptScopeKey(captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId)); }
    catch { /* Keep the existing route fallback until an exact online scope is available. */ }
  }
  const key = JSON.stringify([identity, input.serverId, input.threadId, input.cwd ?? null, input.enabled, transcriptScopeKey,
    input.server?.observationTargetIdentity ?? null]);
  const owner = useRef<{ key: string; mounted: boolean } | null>(null);
  if (owner.current?.key !== key) owner.current = { key, mounted: true };
  const captured = owner.current;
  const latestServer = useRef(input.server);
  latestServer.current = input.server;
  const latestAuthorization = useRef({ profile: input.profile, reauthorizationRequired: input.reauthorizationRequired });
  latestAuthorization.current = { profile: input.profile, reauthorizationRequired: input.reauthorizationRequired };
  const profileReadable = useCacheProfileReadable(input.profile, input.reauthorizationRequired);
  const allowed = input.enabled && profileReadable;
  const readable = useRef(Boolean(allowed));
  readable.current = Boolean(allowed);
  const coordinator = useRef<{ owner: typeof captured; value: SessionCacheCoordinator } | null>(null);
  if (coordinator.current?.owner !== captured) {
    coordinator.current?.value.close();
    coordinator.current = input.profile ? { owner: captured, value: new SessionCacheCoordinator({ profile: { ...input.profile },
      serverId: input.serverId, threadId: input.threadId, cwd: input.cwd },
      () => {
        const latest = latestAuthorization.current;
        return owner.current === captured && captured.mounted && readable.current && Boolean(latest.profile &&
          cacheProfileReadable(latest.profile, latest.reauthorizationRequired) && profileAuthorizationScopeKey(latest.profile) === identity);
      }) } : null;
  }
  const current = coordinator.current?.value;
  const [cached, setCached] = useState<{ owner: typeof captured; value: CachedSession;
    version: { epoch: string; dataRevision: number } | null } | null>(null);
  const [confirmedAbsence, setConfirmedAbsence] = useState<{ owner: typeof captured; observation: ThreadPresenceObservation } | null>(null);
  const [confirmedWorkspaceAbsence, setConfirmedWorkspaceAbsence] = useState<{ owner: typeof captured; observation: WorkspacePresenceObservation } | null>(null);
  const workspacePresenceOwners = useRef(new WeakMap<WorkspacePresenceObservation, typeof captured>());
  const workspaceFlight = useRef<{ owner: typeof captured; proofKey: string; observation: WorkspacePresenceObservation } | null>(null);
  const appliedWorkspaceProof = useRef<{ owner: typeof captured; proofKey: string } | null>(null);
  const latestWorkspacePresence = useRef(input.workspacePresence);
  latestWorkspacePresence.current = input.workspacePresence;
  const appliedPresence = useRef(new WeakSet<ThreadPresenceObservation>());
  const presenceOwners = useRef(new WeakMap<ThreadPresenceObservation, typeof captured>());
  const presenceFlight = useRef<{ owner: typeof captured; observation: ThreadPresenceObservation; proofKey: string } | null>(null);
  const appliedProof = useRef<{ owner: typeof captured; proofKey: string } | null>(null);
  const latestPresence = useRef(input.presence);
  latestPresence.current = input.presence;
  useEffect(() => {
    captured.mounted = true;
    if (allowed && current) void current.loadWithVersion(input.server).then(loaded => {
      if (current.current() && loaded) setCached({ owner: captured, value: loaded.value, version: loaded.version });
    }).catch(() => {});
    return () => { captured.mounted = false; };
  }, [captured, current, Boolean(allowed), input.server]);
  useEffect(() => {
    if (allowed && current && input.task && input.server) {
      setConfirmedAbsence(null);
      setConfirmedWorkspaceAbsence(null);
      return current.watch(input.task, input.server);
    }
  }, [current, Boolean(allowed), input.task, input.server]);
  useEffect(() => {
    const observation = input.presence;
    if (!allowed || !current || !input.server || !observation || observation.result.status !== "absent" || !observation.scope) return;
    const observedOwner = presenceOwners.current.get(observation);
    if (observedOwner && observedOwner !== captured) return;
    if (!observedOwner) presenceOwners.current.set(observation, captured);
    const proofKey = presenceProofKey(observation)!;
    if (input.task || appliedPresence.current.has(observation) ||
        (appliedProof.current?.owner === captured && appliedProof.current.proofKey === proofKey) ||
        (presenceFlight.current?.owner === captured && presenceFlight.current.proofKey === proofKey)) return;
    const flight = { owner: captured, observation, proofKey };
    if (!current.matchesConfirmedAbsentRoute(observation, latestServer.current)) {
      appliedPresence.current.add(observation);
      return;
    }
    if (!observation.version) {
      if (current.suppressCacheOnlyWritesForConfirmedAbsent(observation, latestServer.current)) {
        appliedPresence.current.add(observation);
        appliedProof.current = { owner: captured, proofKey };
        setConfirmedAbsence(flight);
      } else appliedPresence.current.add(observation);
      return;
    }
    presenceFlight.current = flight;
    void current.revokeConfirmedAbsent(observation, input.server, () => latestServer.current).then(result => {
      if (presenceFlight.current !== flight) return;
      // Retry briefly clears presence and may return a new object carrying the same proof.
      // Neither transition replaces the in-flight CAS or discards its successful receipt.
      if ((latestPresence.current && presenceProofKey(latestPresence.current) !== proofKey) ||
          !current.matchesConfirmedAbsentRoute(observation, latestServer.current)) {
        appliedPresence.current.add(observation);
        return;
      }
      appliedPresence.current.add(observation);
      appliedProof.current = { owner: captured, proofKey };
      if (result === true) {
        setCached(null);
        setConfirmedAbsence(flight);
      } else if (result === "persistence-failed") {
        setConfirmedAbsence(flight);
      }
    }).catch(() => { if (presenceFlight.current === flight) appliedPresence.current.add(observation); })
      .finally(() => { if (presenceFlight.current === flight) presenceFlight.current = null; });
  }, [captured, current, Boolean(allowed), input.server, input.presence]);
  useEffect(() => {
    const observation = input.workspacePresence;
    if (!allowed || !current || !input.server || !observation || input.task) return;
    const observedOwner = workspacePresenceOwners.current.get(observation);
    if (observedOwner && observedOwner !== captured) return;
    if (!observedOwner) workspacePresenceOwners.current.set(observation, captured);
    const proofKey = workspaceProofKey(observation);
    if ((appliedWorkspaceProof.current?.owner === captured && appliedWorkspaceProof.current.proofKey === proofKey) ||
        (workspaceFlight.current?.owner === captured && workspaceFlight.current.proofKey === proofKey &&
          current.matchesConfirmedWorkspaceAbsentRoute(workspaceFlight.current.observation, latestServer.current)) ||
        !current.matchesConfirmedWorkspaceAbsentRoute(observation, latestServer.current)) return;
    const flight = { owner: captured, proofKey, observation };
    workspaceFlight.current = flight;
    void current.revokeConfirmedWorkspaceAbsent(observation, input.server, () => latestServer.current).then(result => {
      if (workspaceFlight.current !== flight || (!latestWorkspacePresence.current && result !== true) || (latestWorkspacePresence.current &&
          workspaceProofKey(latestWorkspacePresence.current) !== proofKey) ||
          !current.matchesConfirmedWorkspaceAbsentRoute(observation, latestServer.current)) return;
      appliedWorkspaceProof.current = flight;
      if (result === true || result === "persistence-failed") {
        if (result === true) setCached(null);
        setConfirmedWorkspaceAbsence({ owner: captured, observation });
      }
    }).catch(() => {}).finally(() => { if (workspaceFlight.current === flight) workspaceFlight.current = null; });
  }, [captured, current, Boolean(allowed), input.server, input.task, input.workspacePresence]);
  const hidesConfirmedCache = confirmedAbsence?.owner === captured && cached?.owner === captured &&
    sameVersion(cached.version, confirmedAbsence.observation.version);
  const absenceConfirmed = !input.task && confirmedAbsence?.owner === captured &&
    Boolean(current?.matchesConfirmedAbsentRoute(confirmedAbsence.observation, input.server));
  const workspaceAbsenceConfirmed = !input.task && confirmedWorkspaceAbsence?.owner === captured &&
    Boolean(current?.matchesConfirmedWorkspaceAbsentRoute(confirmedWorkspaceAbsence.observation, input.server));
  const value = !workspaceAbsenceConfirmed && !hidesConfirmedCache && cached?.owner === captured && allowed && current &&
    cachedSessionMatches(cached.value, current.route, input.server) ? cached.value : null;
  return { cached: value, displayOwner: current?.displayOwner ?? captured, readAnchor: current?.readAnchor,
    initialAnchor: current?.displayAnchor(input.task), absenceConfirmed, workspaceAbsenceConfirmed };
}

function workspaceProofKey(observation: WorkspacePresenceObservation): string {
  const version = observation.witness?.version;
  return JSON.stringify([sessionTranscriptScopeKey(observation.scope), observation.result.targetSignature,
    observation.result.workspacePath, observation.result.loginGeneration, version ? [version.epoch, version.revision, version.workspaceKey,
      version.generation, version.prefixDigest] : null]);
}
