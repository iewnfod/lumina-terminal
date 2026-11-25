import type {ReactNode} from "react";
import {Label} from "@heroui/react";
import {TerminalRenderOptions} from "../../types/terminal.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    renderField,
    type RenderField,
    type RenderFieldKey,
    type RenderValue,
    type ToggleRenderField,
} from "../../lib/renderOptions.ts";
import RenderFieldControl from "./RenderFieldControl.tsx";
import {ThemePathPreview} from "../ThemePreview.tsx";
import SettingRow from "../ui/SettingRow.tsx";

export interface RenderSettingsProps {
    draft: TerminalRenderOptions;
    /** Replaces one render field; `undefined` unsets it (a profile inherits
     *  the global value again). Built on `withRenderValue` by both callers. */
    setRenderValue: (key: RenderFieldKey, value: RenderValue | undefined) => void;
    idPrefix: string;
}

/** The Global Profile page's full render-options form — every field, always
 *  visible, since this IS the "global" the per-profile override list
 *  (ProfileRenderOverrides) inherits from. Per-profile overrides are edited
 *  there, not here. */
export default function RenderSettings({draft, setRenderValue, idPrefix}: RenderSettingsProps) {
    const valueOf = (key: RenderFieldKey): RenderValue | undefined => draft[key] as RenderValue | undefined;
    const change = (key: RenderFieldKey) => (value: RenderValue | undefined) => setRenderValue(key, value);

    return (
        <div className="flex flex-col gap-4">
            {/* Rows and Columns */}
            <div className="flex flex-row gap-4">
                <FieldRow field={renderField("rows")} value={valueOf("rows")} onChange={change("rows")} idPrefix={idPrefix} />
                <FieldRow field={renderField("cols")} value={valueOf("cols")} onChange={change("cols")} idPrefix={idPrefix} />
                <FieldRow field={renderField("padding")} value={valueOf("padding")} onChange={change("padding")} idPrefix={idPrefix} />
                <FieldRow field={renderField("scrollback")} value={valueOf("scrollback")} onChange={change("scrollback")} idPrefix={idPrefix} />
            </div>

            {/* Font Family */}
            <FieldRow
                field={renderField("fontFamily")}
                value={valueOf("fontFamily")}
                onChange={change("fontFamily")}
                idPrefix={idPrefix}
                className="max-w-sm"
            />

            {/* Font Size / Weight / Style */}
            <div className="flex flex-row gap-5">
                <FieldRow field={renderField("fontSize")} value={valueOf("fontSize")} onChange={change("fontSize")} idPrefix={idPrefix} />
                <FieldRow field={renderField("fontWeight")} value={valueOf("fontWeight")} onChange={change("fontWeight")} idPrefix={idPrefix} />
                <FieldRow field={renderField("fontStyle")} value={valueOf("fontStyle")} onChange={change("fontStyle")} idPrefix={idPrefix} />
            </div>

            {/* Cursor Style + Blink */}
            <div className="flex flex-row gap-5 items-end">
                <FieldRow field={renderField("cursorStyle")} value={valueOf("cursorStyle")} onChange={change("cursorStyle")} idPrefix={idPrefix} />
                <ToggleRow
                    field={renderField("cursorBlink")}
                    className="pb-1.5"
                    value={valueOf("cursorBlink")}
                    onChange={change("cursorBlink")}
                    idPrefix={idPrefix}
                />
            </div>

            {/* Theme Path */}
            <FieldRow field={renderField("themePath")} value={valueOf("themePath")} onChange={change("themePath")} idPrefix={idPrefix}>
                <ThemePathPreview options={draft} />
            </FieldRow>

            <ToggleRow field={renderField("webgl")} value={valueOf("webgl")} onChange={change("webgl")} idPrefix={idPrefix} />
            <ToggleRow field={renderField("graphemeClusters")} value={valueOf("graphemeClusters")} onChange={change("graphemeClusters")} idPrefix={idPrefix} />
            <ToggleRow field={renderField("ligatures")} value={valueOf("ligatures")} onChange={change("ligatures")} idPrefix={idPrefix} />
        </div>
    );
}

type RowProps = {
    value: RenderValue | undefined;
    onChange: (value: RenderValue | undefined) => void;
    idPrefix: string;
    className?: string;
    children?: ReactNode;
};

/** Label above the control (number, text and select fields). */
function FieldRow({field, value, onChange, idPrefix, className, children}: RowProps & {field: RenderField}) {
    const t = useI18n();
    return (
        <SettingRow label={<Label htmlFor={`${idPrefix}-${field.key}`}>{t[field.labelKey]}</Label>}>
            <RenderFieldControl field={field} value={value} onChange={onChange} idPrefix={idPrefix} className={className}>
                {children}
            </RenderFieldControl>
        </SettingRow>
    );
}

/** Label (+ description) on the left, the switch on the right; clicking the
 *  label toggles too. */
function ToggleRow({field, value, onChange, idPrefix, className}: RowProps & {field: ToggleRenderField}) {
    const t = useI18n();
    return (
        <SettingRow
            variant="toggle"
            className={className}
            label={<Label className="cursor-pointer">{t[field.labelKey]}</Label>}
            description={field.descriptionKey ? t[field.descriptionKey] : undefined}
            onClick={() => onChange(value !== true)}
        >
            <RenderFieldControl field={field} value={value} onChange={onChange} idPrefix={idPrefix} />
        </SettingRow>
    );
}
