import { registerRootComponent } from "expo";
import { initLocale } from "../../../mobile/src/i18n";
import { initTheme } from "../../../mobile/src/theme";
import { updateAppPreferences } from "../../../mobile/src/storage/app-preferences";
import { loadConversationFonts } from "../../../mobile/src/features/conversation/conversation-fonts";
import "../../../mobile/src/web-styles";
import SendRecoveryFixture from "./App";

const params = new URLSearchParams(window.location.search);
const language = params.get("language") === "en" ? "en" : "zh-CN";
initLocale(language);
initTheme(params.get("theme") === "dark" ? "dark" : "light");
// AsyncStorage resolves to fixture-only memory; production preferences are never touched.
updateAppPreferences({ interfaceVersion: "v3", language });
void loadConversationFonts();
registerRootComponent(SendRecoveryFixture);
