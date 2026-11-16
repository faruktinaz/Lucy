/**
 * Text inputs on the inset surface. While one has renderable focus the router sets the
 * `inputFocus` context key, so typing never triggers a keybinding.
 */
import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import { type Ref, useImperativeHandle, useRef } from "react";
import type { IconName } from "@/themes/icons";
import { useTheme } from "../theme/theme-context";
import { Icon } from "./icon";

export interface TextFieldHandle {
  focus(): void;
  blur(): void;
  readonly value: string;
  setValue(value: string): void;
}

export interface TextFieldProps {
  value?: string;
  placeholder?: string;
  icon?: IconName;
  focused?: boolean;
  onInput?: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Background behind the field; defaults to the inset token. */
  inset?: boolean;
  maxLength?: number;
  width?: number | `${number}%`;
  ref?: Ref<TextFieldHandle>;
  /** Marks the field as invalid (error-colored icon). */
  invalid?: boolean;
}

export function TextField({
  value,
  placeholder,
  icon,
  focused = false,
  onInput,
  onSubmit,
  inset = true,
  maxLength,
  width,
  ref,
  invalid = false,
}: TextFieldProps) {
  const theme = useTheme();
  const c = theme.colors;
  const input = useRef<InputRenderable>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      blur: () => input.current?.blur(),
      get value() {
        return input.current?.value ?? "";
      },
      setValue: (next: string) => {
        if (input.current) input.current.value = next;
      },
    }),
    [],
  );
  const bg = inset ? c.bg.inset : undefined;
  const iconColor = invalid ? c.status.error : focused ? c.accent.primary : c.fg.subtle;
  return (
    <box height={1} flexDirection="row" backgroundColor={bg} paddingX={1} width={width} flexShrink={0}>
      {icon ? (
        <text fg={iconColor} selectable={false} flexShrink={0}>
          <Icon name={icon} color={iconColor} />
        </text>
      ) : null}
      <input
        ref={input}
        flexGrow={1}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        focused={focused}
        backgroundColor={bg ?? c.bg.base}
        focusedBackgroundColor={bg ?? c.bg.base}
        textColor={c.fg.default}
        focusedTextColor={c.fg.default}
        placeholderColor={c.fg.subtle}
        cursorColor={c.accent.primary}
        selectionBg={c.editor.selectionBg}
        onInput={onInput}
        onSubmit={onSubmit}
      />
    </box>
  );
}

export interface TextAreaFieldProps {
  initialValue?: string;
  placeholder?: string;
  focused?: boolean;
  height?: number;
  onContentChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  ref?: Ref<TextareaRenderable>;
}

/** Multi-line input (commit messages, prompts). Alt+Enter submits, Enter inserts a newline. */
export function TextAreaField({
  initialValue,
  placeholder,
  focused = false,
  height = 3,
  onContentChange,
  onSubmit,
  ref,
}: TextAreaFieldProps) {
  const theme = useTheme();
  const c = theme.colors;
  const area = useRef<TextareaRenderable>(null);
  useImperativeHandle(ref, () => area.current as TextareaRenderable, []);
  return (
    <box height={height} backgroundColor={c.bg.inset} paddingX={1} flexShrink={0}>
      <textarea
        ref={area}
        flexGrow={1}
        initialValue={initialValue}
        placeholder={placeholder}
        focused={focused}
        backgroundColor={c.bg.inset}
        focusedBackgroundColor={c.bg.inset}
        textColor={c.fg.default}
        focusedTextColor={c.fg.default}
        placeholderColor={c.fg.subtle}
        cursorColor={c.accent.primary}
        selectionBg={c.editor.selectionBg}
        wrapMode="word"
        onContentChange={() => onContentChange?.(area.current?.plainText ?? "")}
        onSubmit={() => onSubmit?.(area.current?.plainText ?? "")}
      />
    </box>
  );
}
