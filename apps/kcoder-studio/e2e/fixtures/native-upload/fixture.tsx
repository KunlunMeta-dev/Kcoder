// A presentation fixture for retained upload components without a local KCoder
// route. Package parsing and keyboard behavior execute in the native WebView.
import "@/i18n";
import "@/styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginUploadDialog } from "@/components/plugins/PluginUploadDialog";
import { SkillUploadDialog } from "@/components/plugins/SkillUploadDialog";
import { Button } from "@/components/ui/button";
import { installStudioAutomationBridge } from "@/e2e/automation";

function Fixture() {
  const [dialog, setDialog] = useState<"plugin" | "skill" | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <main className="min-h-screen bg-background p-5 text-text-primary">
      <h1 className="heading-sm">Owned upload presentation</h1>
      <div className="mt-4 flex gap-2">
        <Button
          data-testid="open-plugin-upload"
          onClick={() => setDialog("plugin")}
        >
          Plugin
        </Button>
        <Button
          data-testid="open-skill-upload"
          onClick={() => setDialog("skill")}
        >
          Skill
        </Button>
        <Button
          data-testid="upload-theme"
          onClick={() => {
            const root = document.documentElement;
            const dark = root.dataset.theme !== "dark";
            root.dataset.theme = dark ? "dark" : "light";
            root.classList.toggle("dark", dark);
          }}
        >
          Theme
        </Button>
      </div>
      {dialog === "plugin" && (
        <PluginUploadDialog
          isUploading={pending}
          onCancel={() => setDialog(null)}
          onUpload={async () => setPending(true)}
        />
      )}
      {dialog === "skill" && (
        <SkillUploadDialog
          isUploading={pending}
          onCancel={() => setDialog(null)}
          onUpload={async () => setPending(true)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
installStudioAutomationBridge();
