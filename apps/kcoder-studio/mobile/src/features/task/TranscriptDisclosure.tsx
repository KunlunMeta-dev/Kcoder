import { createContext, useContext, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";

const ProcessingHeaderLayout = createContext<((height: number) => void) | null>(
  null,
);

export function TranscriptDisclosureHeader({
  testID,
  label,
  expanded,
  disabled = false,
  onPress,
  icon,
  children,
}: {
  testID: string;
  label?: string;
  expanded: boolean;
  disabled?: boolean;
  onPress(): void;
  icon: ReactNode;
  children: ReactNode;
}) {
  const { styles, colors } = useTaskAppearance();
  const reportHeaderHeight = useContext(ProcessingHeaderLayout);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{
        expanded: disabled ? undefined : expanded,
        disabled,
      }}
      aria-expanded={disabled ? undefined : expanded}
      disabled={disabled}
      onPress={onPress}
      style={styles.transcriptDisclosureHeader}
      onLayout={
        reportHeaderHeight
          ? (event) => {
              reportHeaderHeight(event.nativeEvent.layout.height);
            }
          : undefined
      }
    >
      <View
        testID={`transcript-node-${testID}`}
        style={styles.processingStepGlyph}
      >
        {icon}
      </View>
      {children}
      {!disabled ? (
        <View
          testID={`transcript-chevron-${testID}`}
          style={styles.processingStepChevron}
        >
          {expanded ? (
            <ChevronDown size={20} color={colors.textDim} />
          ) : (
            <ChevronRight size={20} color={colors.textDim} />
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

export function ProcessingStep({
  first,
  last,
  testID,
  children,
}: {
  first: boolean;
  last: boolean;
  testID: string;
  children: ReactNode;
}) {
  const { styles } = useTaskAppearance();
  const [headerHeight, setHeaderHeight] = useState(48);
  return (
    <ProcessingHeaderLayout.Provider value={setHeaderHeight}>
      <View testID={testID} style={styles.processingStep}>
        {!(first && last) ? (
          <View
            testID={`${testID}-connector`}
            accessible={false}
            style={[
              styles.processingStepConnector,
              first && { top: headerHeight / 2 },
              last && { bottom: undefined, height: headerHeight / 2 },
              { pointerEvents: "none" },
            ]}
          />
        ) : null}
        {children}
      </View>
    </ProcessingHeaderLayout.Provider>
  );
}
