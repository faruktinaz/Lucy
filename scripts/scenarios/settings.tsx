/**
 * Screenshot scenarios of the Settings feature: the Settings editor, live validation, the
 * theme picker's live preview, the Keyboard Shortcuts editor, the capture card with a
 * conflict, two onboarding steps and the Integrations view.
 */
import { settingsServices } from "@/features/settings";
import { defineScenario, SIZES, until } from "../screenshots";

const sizes = [SIZES.wide, SIZES.medium];

defineScenario(
  "settings-editor",
  async (app) => {
    await app.tui.act(async () => {
      await app.ctx.config.set("ui.animations", false, { persist: false });
      await app.ctx.config.set("editor.wrap", true, { persist: false });
    });
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
    for (let i = 0; i < 5; i++) await app.tui.press("down");
  },
  { description: "The Settings editor with a modified setting selected", sizes },
);

defineScenario(
  "settings-validation",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
    await app.tui.type("sidebar width");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.press("backspace");
    await app.tui.press("backspace");
    await app.tui.type("5");
  },
  { description: "Editing a number in place with the live validation message", sizes },
);

defineScenario(
  "settings-theme-preview",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.press("down");
  },
  { description: "The theme option picker previewing Tokyo Night live", sizes },
);

defineScenario(
  "settings-problems",
  async (app) => {
    await app.tui.act(async () => {
      await Bun.write(
        app.ctx.config.path,
        'version = 1\n[ui]\nicons = "nerd"\ntheme = "dracula"\ncolour = "red"\n',
      );
      await app.ctx.config.reload();
    });
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
  },
  { description: "Config file problems in the banner above the settings", sizes: [SIZES.wide] },
);

defineScenario(
  "keybindings-editor",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("keybindings.open"));
    for (let i = 0; i < 4; i++) await app.tui.press("down");
  },
  { description: "Every command with its shortcuts, sources, contexts and warnings", sizes },
);

defineScenario(
  "keybinding-capture",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("keybindings.open"));
    await app.tui.type("toggle sidebar");
    await app.tui.press("down");
    await app.tui.press("+");
    await app.tui.press("ctrl+p");
    await app.tui.press("enter");
  },
  { description: "The capture card reviewing a shortcut that conflicts with Go to File", sizes },
);

defineScenario(
  "onboarding-theme",
  async (app) => {
    void app.ctx.commands.execute("onboarding.run");
    await app.tui.settle();
    await app.tui.press("down");
  },
  { description: "First-run setup: the theme step previewing Tokyo Night behind the card", sizes },
);

defineScenario(
  "onboarding-icons",
  async (app) => {
    void app.ctx.commands.execute("onboarding.run");
    await app.tui.settle();
    await app.tui.press("enter");
  },
  { description: "First-run setup: the icons step with sample Nerd Font glyphs", sizes },
);

defineScenario(
  "integrations",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("view.showIntegrations"));
    const model = settingsServices(app.ctx).integrations();
    await until(app, () => model.state.checkedAt !== null, 15_000);
  },
  { description: "Tools Lucy works with on this machine, terminal capabilities, built-in modules", sizes },
);
