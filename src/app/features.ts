/**
 * The feature modules, in activation order (also the order of their contributions where no
 * explicit `order` is given). Add a feature by importing its module here.
 */
import { aiFeature } from "@/features/ai";
import { editorFeature } from "@/features/editor";
import { explorerFeature } from "@/features/explorer";
import { searchFeature } from "@/features/search";
import { settingsFeature } from "@/features/settings";
import { sourceControlFeature } from "@/features/source-control";
import { terminalFeature } from "@/features/terminal";
import type { FeatureModule } from "./feature";

export const FEATURES: readonly FeatureModule[] = [
  explorerFeature,
  searchFeature,
  sourceControlFeature,
  editorFeature,
  terminalFeature,
  aiFeature,
  settingsFeature,
];
