// Keep static asset references together so Metro includes fonts and the complete OFL text.
export function getConversationFontAssets() {
  return {
    regular: require("../../../../shared/assets/fonts/noto-sans-sc/NotoSansSC-Regular.otf") as number,
    bold: require("../../../../shared/assets/fonts/noto-sans-sc/NotoSansSC-Bold.otf") as number,
    license: require("../../../../shared/assets/fonts/noto-sans-sc/OFL.txt") as number,
  };
}
