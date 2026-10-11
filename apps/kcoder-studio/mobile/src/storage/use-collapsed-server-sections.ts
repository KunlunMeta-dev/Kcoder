import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getCollapsedServerSectionsSnapshot,
  hydrateCollapsedServerSections,
  subscribeCollapsedServerSections,
  toggleProfileServerCollapsed,
} from "./collapsed-server-sections";

export function useCollapsedServerSections(profileId: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeCollapsedServerSections(profileId, listener),
    [profileId],
  );
  const getSnapshot = useCallback(
    () => getCollapsedServerSectionsSnapshot(profileId),
    [profileId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void hydrateCollapsedServerSections(profileId);
  }, [profileId]);

  const toggle = useCallback(
    (serverId: string) => toggleProfileServerCollapsed(profileId, serverId),
    [profileId],
  );

  return { ...snapshot, toggle };
}
