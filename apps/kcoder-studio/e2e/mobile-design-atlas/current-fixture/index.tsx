import { registerRootComponent } from "expo";
import { initLocale } from "../../../mobile/src/i18n";
import { initTheme } from "../../../mobile/src/theme";
import { updateAppPreferences } from "../../../mobile/src/storage/app-preferences";
import { loadConversationFonts } from "../../../mobile/src/features/conversation/conversation-fonts";
import "../../../mobile/src/web-styles";
import CurrentV3Fixture from "./App";

const params = new URLSearchParams(window.location.search);
const language = params.get("language") === "en" ? "en" : "zh-CN";
initLocale(language);
initTheme(params.get("theme") === "dark" ? "dark" : "light");
// AsyncStorage resolves to fixture-only memory; production preferences are never touched.
updateAppPreferences({ interfaceVersion: "v3", language, quickPhrases: [{ id: "review", title: "检查布局", content: "请帮我检查当前界面的布局与操作入口。" }] });
void loadConversationFonts();
registerRootComponent(CurrentV3Fixture);
