/**
 * Breadcrumb segments above the viewer: `src › features › editor › index.ts`.
 *
 * Labels are display-safe (file names are untrusted and may contain control or bidi-override
 * characters); `path` keeps the raw workspace-relative prefix so a click can reveal that
 * folder in the explorer.
 */
import { sanitizeForDisplay } from "@/core/text";

export interface BreadcrumbSegment {
  /** Display-safe segment name. */
  readonly label: string;
  /** Raw workspace-relative path up to and including this segment. */
  readonly path: string;
  /** The last segment (the file itself). */
  readonly isLast: boolean;
}

export function breadcrumbSegments(relativePath: string): BreadcrumbSegment[] {
  // Tolerate "./a", "a//b" and a trailing slash: breadcrumbs must never throw on odd input.
  const parts = relativePath.split("/").filter((part) => part !== "" && part !== ".");
  const segments: BreadcrumbSegment[] = [];
  let prefix = "";
  parts.forEach((part, index) => {
    prefix = prefix === "" ? part : `${prefix}/${part}`;
    segments.push({ label: sanitizeForDisplay(part), path: prefix, isLast: index === parts.length - 1 });
  });
  return segments;
}
