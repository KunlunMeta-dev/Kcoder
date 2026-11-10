import { AndroidUpdatePanel } from "./AndroidUpdatePanel";
import { androidUpdater } from "./android-update-native";
import { useIsFocused } from "expo-router";

export default function AndroidAppUpdateSection() { return <AndroidUpdatePanel updater={androidUpdater} active={useIsFocused()} />; }
