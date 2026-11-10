import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { spacing } from "@/theme";
import { useTaskAppearance } from "./taskStyles";

type Entry = { owner: object; content: ReactNode; top: number };
type Layer = {
  host: React.RefObject<ViewInstance | null>;
  show(entry: Entry): void;
  remove(owner: object): void;
};
const Context = createContext<Layer | null>(null);

/** A panel-sized native hit-test owner for controls floating above the composer. */
export function ComposerFloatingLayer({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const host = useRef<ViewInstance>(null);
  const [height, setHeight] = useState(0);
  const [entry, setEntry] = useState<Entry | null>(null);
  const layer = useMemo<Layer>(() => ({ host, show: setEntry,
    remove: owner => setEntry(current => current?.owner === owner ? null : current),
  }), []);
  const { styles } = useTaskAppearance();
  return <Context.Provider value={layer}>
    <View ref={host} testID="composer-floating-host" collapsable={false} style={style} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
      {children}
      {entry ? <View style={[StyleSheet.absoluteFill, { zIndex: 10, pointerEvents: "box-none" }]}>
        <View style={[styles.composerFloatingControls,
          { bottom: Math.max(0, height - entry.top), marginBottom: spacing.sm, pointerEvents: "box-none" }]}>{entry.content}</View>
      </View> : null}
    </View>
  </Context.Provider>;
}

/** Web permits overflow interaction; native controls live inside their panel bounds. */
export function ComposerFloatingAnchor({ children, controls, floating }: {
  children: ReactNode; controls: ReactNode; floating: boolean;
}) {
  const layer = useContext(Context);
  const native = floating && Platform.OS !== "web" && Boolean(layer);
  const anchor = useRef<ViewInstance>(null);
  const owner = useRef({}).current;
  const active = useRef(true);
  const generation = useRef(0);
  const { styles } = useTaskAppearance();
  const place = useCallback(() => {
    if (!native || !layer || !controls || !layer.host.current) return;
    const observedGeneration = generation.current;
    anchor.current?.measureLayout(layer.host.current, (_x, top) => {
      if (active.current && generation.current === observedGeneration) layer.show({ owner, content: controls, top });
    });
  }, [native, layer, controls, owner]);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current++; layer?.remove(owner); };
  }, [layer, owner]);
  useLayoutEffect(() => {
    if (native && controls) place();
    else layer?.remove(owner);
    // Keep mounted controls through remeasurement so an in-flight press can finish.
    return () => { generation.current++; };
  }, [native, controls, place, layer, owner]);
  return <View ref={anchor} collapsable={false} testID="submission-recovery-anchor"
    onLayout={place} style={floating ? styles.submissionRecoveryAnchor : undefined}>
    {floating && !native && controls ? <View testID="composer-floating-controls"
      style={[styles.composerFloatingControls, { pointerEvents: "box-none" }]}>{controls}</View> : null}
    {children}
  </View>;
}
