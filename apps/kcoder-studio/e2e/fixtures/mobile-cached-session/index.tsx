import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import { initLocale } from "../../../mobile/src/i18n";
import { initTheme } from "../../../mobile/src/theme";
import { loadConversationFonts } from "../../../mobile/src/features/conversation/conversation-fonts";
import "../../../mobile/src/web-styles";
import CachedConversationFixture from "./App";

const params = new URLSearchParams(window.location.search);
const english = params.get("language") === "en";
initLocale(english ? "en" : "zh-CN");
initTheme(params.get("theme") === "light" ? "light" : "dark");
void loadConversationFonts();

registerRootComponent(CachedConversationFixture);
