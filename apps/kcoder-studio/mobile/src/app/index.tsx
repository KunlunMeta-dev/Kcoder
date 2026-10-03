import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useApp } from "@/state/AppContext";
import { colors } from "@/theme";

export default function IndexRoute() {
  const { hydrated, activeProfile } = useApp();
  if (!hydrated) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }
  if (!activeProfile) return <Redirect href="/welcome" />;
  if (activeProfile.expiresAt <= Date.now()) {
    return <Redirect href={{ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } }} />;
  }
  return <Redirect href={{ pathname: "/h/[profileId]", params: { profileId: activeProfile.id } }} />;
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background } });
