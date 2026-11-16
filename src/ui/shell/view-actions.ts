import { useApp } from "@/app/react";
import type { ViewAction } from "@/app/workbench/views";
import type { HeaderAction } from "../primitives/headers";

/** Turns command-based view actions into header buttons with hover hints. */
export function useViewActions(actions: readonly ViewAction[] | undefined): HeaderAction[] {
  const app = useApp();
  return (actions ?? []).map((action) => ({
    icon: action.icon,
    hint: {
      text: action.title ?? app.commands.get(action.command)?.title ?? action.command,
      keys: app.keybindingFor(action.command),
    },
    onPress: () => void app.run(action.command, action.args),
  }));
}
