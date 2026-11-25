import {useState, type ReactNode} from "react";
import {Input, ListBox, Select, Switch} from "@heroui/react";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    formatPaddingObject,
    optionLabelKey,
    parseNumberInput,
    type RenderField,
    type RenderValue,
} from "../../lib/renderOptions.ts";

/** ListBox item id of a select's "use the global setting" choice. */
export const INHERIT_KEY = "__inherit__";

export interface RenderFieldControlProps {
    field: RenderField;
    value: RenderValue | undefined;
    /** Called with the new value; `undefined` = unset (inherit). */
    onChange: (value: RenderValue | undefined) => void;
    /** Prefix of the input ids, so a `<Label htmlFor>` can target them. */
    idPrefix: string;
    /** Override mode — a profile's row, where the field falls back to the
     *  global setting when unset. Selects offer it as their first item,
     *  inputs show it as the placeholder, and clearing an input keeps the row
     *  (an emptied text field holds `""`, dropped as unset on save; an
     *  emptied number field unsets on blur) instead of deleting it under the
     *  user's cursor. Omitted on the Global Profile page. */
    inherit?: {label: string; value: string};
    /** Extra classes on the wrapper — this is where a caller sets the width
     *  (text inputs fill it; the other controls have their own). */
    className?: string;
    /** Rendered right of the control (the theme swatch preview). */
    children?: ReactNode;
}

/** The control for one render field — number input, text input, select or
 *  switch, as the field's `kind` says. The single place these are built, so
 *  the Global Profile page's full form and each profile's override list stay
 *  identical control for control. Labels and rows are the caller's. */
export default function RenderFieldControl({
    field,
    value,
    onChange,
    idPrefix,
    inherit,
    className = "",
    children,
}: RenderFieldControlProps) {
    const t = useI18n();
    const id = `${idPrefix}-${field.key}`;

    const optionLabel = (option: string) => {
        const key = optionLabelKey(field, option);
        return key === null ? option : t[key];
    };

    // Override mode buffers the number input's text while it is focused, so
    // clearing it to type a new value does not commit "unset" (which would
    // delete the row) on the keystroke: valid values commit as typed, an
    // emptied field commits "unset" only when it loses focus.
    const [numberText, setNumberText] = useState<string | null>(null);

    // A per-side padding object cannot be shown in a number input: the field
    // stays empty and a note under it spells the object out, until the user
    // types a number — which replaces it.
    const paddingNote =
        typeof value === "object"
            ? t["Per-side padding ({v}) — type a number to replace it"].replace(
                  "{v}",
                  formatPaddingObject(value),
              )
            : undefined;

    return (
        <div className={`flex flex-col gap-1.5 ${className}`}>
            <div className="flex flex-row items-center gap-3">
                {field.kind === "number" && (
                    <Input
                        id={id}
                        type="number"
                        min={field.min}
                        value={numberText ?? (typeof value === "number" ? String(value) : "")}
                        placeholder={
                            typeof value === "object" ? undefined : inherit ? `${inherit.label}: ${inherit.value}` : undefined
                        }
                        onChange={(e) => {
                            if (!inherit) {
                                onChange(parseNumberInput(e.target.value, field.min));
                                return;
                            }
                            setNumberText(e.target.value);
                            const parsed = parseNumberInput(e.target.value, field.min);
                            if (parsed !== undefined) onChange(parsed);
                        }}
                        onBlur={() => {
                            // Leaving the field empty means "unset" — committed on
                            // blur, so the row never vanishes under the caret.
                            if (numberText !== null && parseNumberInput(numberText, field.min) === undefined) {
                                onChange(undefined);
                            }
                            setNumberText(null);
                        }}
                        className="w-24"
                    />
                )}
                {field.kind === "text" && (
                    <Input
                        id={id}
                        value={typeof value === "string" ? value : ""}
                        placeholder={inherit ? `${inherit.label}: ${inherit.value}` : field.placeholder}
                        onChange={(e) => onChange(e.target.value || (inherit ? "" : undefined))}
                        className="flex-1 min-w-0"
                    />
                )}
                {field.kind === "select" && (
                    <Select
                        // An unset select shows the built-in default on the global
                        // page (nothing is written until the user picks) and the
                        // inherit item in override mode.
                        selectedKey={
                            typeof value === "string" && value
                                ? value
                                : inherit
                                    ? INHERIT_KEY
                                    : field.fallback
                        }
                        onSelectionChange={(key) => {
                            if (key === INHERIT_KEY) {
                                onChange(undefined);
                            } else if (key) {
                                onChange(String(key));
                            }
                        }}
                        className="w-32"
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                {inherit && (
                                    <ListBox.Item id={INHERIT_KEY} textValue={`${inherit.label} (${inherit.value})`}>
                                        {inherit.label} ({inherit.value})
                                    </ListBox.Item>
                                )}
                                {field.options.map((option) => (
                                    <ListBox.Item id={option} key={option} textValue={optionLabel(option)}>
                                        {optionLabel(option)}
                                    </ListBox.Item>
                                ))}
                            </ListBox>
                        </Select.Popover>
                    </Select>
                )}
                {field.kind === "toggle" && (
                    <Switch isSelected={value === true} onChange={onChange}>
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                    </Switch>
                )}
                {children}
            </div>
            {paddingNote && <p className="text-xs text-muted">{paddingNote}</p>}
        </div>
    );
}
