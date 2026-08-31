import {useCallback, useEffect, useMemo, useState} from "react";
import {Button, Input, Label, Tooltip} from "@heroui/react";
import {ImagePlus, Plus, Regex, Trash2} from "lucide-react";
import {info} from "@tauri-apps/plugin-log";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {CommandIconRule} from "../../types/config.ts";
import {
    customIconId,
    customIconName,
    getAppIcon,
    isCustomIconId,
    isValidRegex,
    ruleMatches,
} from "../../lib/appIcon.ts";
import {
    listCommandIcons,
    pruneCommandIcons,
} from "../../lib/commandIconApi.ts";
import IconPicker from "./IconPicker.tsx";
import AppIcon from "../AppIcon.tsx";
import SettingsShell from "../ui/SettingsShell.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";
import SaveFooter from "../ui/SaveFooter.tsx";
import {useSettingsDraft} from "../../hooks/useSettingsDraft.ts";

/** One rule row + its expandable icon picker. Split out of the panel body so
 * the picker grid's per-row open state stays local to the row. */
function RuleRow({
    rule,
    invalidRegex,
    dark,
    borderColor,
    onChange,
    onDelete,
    customIconIds,
    onImported,
    ruleIndex,
}: {
    rule: CommandIconRule;
    invalidRegex: boolean;
    /** Dark background flag for icon variant rendering. */
    dark: boolean;
    borderColor: string;
    onChange: (updates: Partial<CommandIconRule>) => void;
    onDelete: () => void;
    /** Every stored custom icon (plus any the draft references), as `custom:`
     * ids — offered in the picker so icons stay selectable after a rule is
     * switched away; they are only removed from disk by a save's prune. */
    customIconIds: string[];
    /** Notifies the panel that a new icon file was stored (refresh pickers). */
    onImported: (name: string) => void;
    ruleIndex: number;
}) {
    const t = useI18n();
    const [pickerOpen, setPickerOpen] = useState(false);

    return (
        <div
            className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3"
            style={{borderColor}}
        >
            <div className="flex flex-row items-center gap-2">
                <span className="text-sm font-mono text-muted">#{ruleIndex+1}</span>
                <Input
                    value={rule.match}
                    onChange={(e) => onChange({match: e.target.value})}
                    className="flex-1 font-mono mr-1"
                    placeholder={rule.isRegex ? "^git\\s+push" : "vim"}
                    aria-label={t["Match"]}
                />
                {/* Regex toggle — switches the match field between a plain
                    command name and a regex tested against the whole line. */}
                <Tooltip delay={300} closeDelay={0}>
                    <Tooltip.Trigger>
                        <Button
                            variant={rule.isRegex ? "primary" : "outline"}
                            size="sm"
                            onPress={() => onChange({isRegex: !rule.isRegex})}
                        >
                            <Regex size={14} />
                        </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                        {t["Regular expression - match the whole command line"]}
                    </Tooltip.Content>
                </Tooltip>
                <Tooltip delay={300} closeDelay={0}>
                    <Tooltip.Trigger>
                <Button
                    variant="outline"
                    size="sm"
                    onPress={() => setPickerOpen((v) => !v)}
                >
                    {rule.icon ? (
                        <AppIcon app={rule.icon} dark={dark} size={18} />
                    ) : (
                        <ImagePlus size={14} />
                    )}
                </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>{t["Choose icon"]}</Tooltip.Content>
                </Tooltip>
                <Tooltip delay={300} closeDelay={0}>
                    <Tooltip.Trigger>
                        <Button variant="outline" size="sm" onPress={onDelete}>
                            <Trash2 size={14} />
                        </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>{t["Delete"]}</Tooltip.Content>
                </Tooltip>
            </div>
            {rule.isRegex && invalidRegex && (
                <p className="text-xs" style={{color: "var(--lum-danger, #e5484d)"}}>
                    {t["Invalid regular expression"]}
                </p>
            )}
            {pickerOpen && (
                <div className="pt-1">
                    <IconPicker
                        selected={rule.icon}
                        onPick={(id) => {
                            onChange({icon: id});
                            setPickerOpen(false);
                        }}
                        dark={dark}
                        customIconIds={customIconIds}
                        onImported={onImported}
                    />
                </div>
            )}
        </div>
    );
}

export default function CommandIconSettings({
    borderColor,
    dark,
}: {
    borderColor: string;
    /** Whether the settings background is dark (picks icon variants). */
    dark: boolean;
}) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();

    // All imported icon files on disk — the picker's source of truth (not the
    // draft), so icons remain selectable while editing.
    const [storedIcons, setStoredIcons] = useState<string[]>([]);
    useEffect(() => {
        listCommandIcons()
            .then((names) => setStoredIcons(names))
            .catch(() => {});
    }, []);

    const source = useMemo(() => config.commandIcons ?? [], [config.commandIcons]);
    const {draft, setDraft, isDirty, save} = useSettingsDraft<CommandIconRule[]>(
        source,
        (next) => {
            info(`Command icon rules saved (${next.length} rule(s))`);
            updateConfig({commandIcons: next});
            // Drop imported files no saved rule references anymore (the ONLY
            // cleanup moment — until then every stored icon stays pickable so
            // a rule can be switched away and back). Fire-and-forget with a
            // logged rejection, then re-list so the pickers drop the pruned
            // entries.
            pruneCommandIcons(
                next.filter((r) => isCustomIconId(r.icon)).map((r) => customIconName(r.icon)),
            )
                .then(() => listCommandIcons())
                .then((names) => setStoredIcons(names))
                .catch(() => {});
        },
        [config.commandIcons],
    );

    // A rule with an invalid regex blocks Save (it would silently never match)
    // and is flagged inline.
    const invalidIndexes = useMemo(
        () =>
            draft
                .map((r, i) => (r.isRegex && !isValidRegex(r.match) ? i : -1))
                .filter((i) => i >= 0),
        [draft],
    );
    const hasInvalid = invalidIndexes.length > 0;

    // Every stored custom icon (as `custom:` ids), plus any the draft still
    // references (covers a just-imported icon before the list refresh lands).
    const customIconIds = useMemo(() => {
        const ids = [
            ...storedIcons.map(customIconId),
            ...draft.map((r) => r.icon).filter(isCustomIconId),
        ];
        return [...new Set(ids)];
    }, [storedIcons, draft]);

    const updateRule = useCallback((index: number, updates: Partial<CommandIconRule>) => {
        setDraft((prev) => prev.map((r, i) => (i === index ? {...r, ...updates} : r)));
    }, [setDraft]);

    const deleteRule = useCallback((index: number) => {
        setDraft((prev) => prev.filter((_, i) => i !== index));
    }, [setDraft]);

    const addRule = useCallback(() => {
        setDraft((prev) => [...prev, {match: "", isRegex: false, icon: ""}]);
    }, [setDraft]);

    // Live preview: which rule/icon a typed command line resolves to.
    const [previewLine, setPreviewLine] = useState("");
    const preview = useMemo(() => {
        if (!previewLine.trim()) return null;
        for (let i = 0; i < draft.length; i++) {
            if (ruleMatches(draft[i], previewLine)) {
                return {ruleIndex: i, icon: draft[i].icon};
            }
        }
        return {ruleIndex: -1, icon: getAppIcon(previewLine)}; // built-in / none
    }, [draft, previewLine]);

    return (
        <SettingsShell
            footer={
                <SaveFooter
                    isDisabled={!isDirty || hasInvalid}
                    saveLabel={t["Save"]}
                    onPressSave={save}
                    isDirty={isDirty}
                    unsavedLabel={hasInvalid ? t["Fix invalid regular expressions first"] : t["Unsaved changes"]}
                    borderColor={borderColor}
                />
            }
        >
            <SectionTitle
                subtitle={t[
                    "The tab icon follows the running command. Plain rules match the command name; regex rules match the whole command line. Rules run top to bottom before the built-in icons."
                ]}
            >
                {t["Command Icons"]}
            </SectionTitle>

            <div className="flex flex-col gap-2">
                <div className="flex flex-row items-center justify-between">
                    <SectionTitle variant="subsection" className="text-center" style={{marginBottom: 0 }}>
                        {t["{n} rule(s) in total"].replace("{n}", String(draft.length))}
                    </SectionTitle>
                    <Button variant="outline" size="sm" onPress={addRule} className="self-start">
                        <Plus size={14} />
                        {t["Add Rule"]}
                    </Button>
                </div>

                {draft.length === 0 && (
                    <p className="text-sm text-muted">{t["No command icon rules yet."]}</p>
                )}
                {draft.map((rule, i) => (
                    <RuleRow
                        key={i}
                        rule={rule}
                        invalidRegex={invalidIndexes.includes(i)}
                        dark={dark}
                        borderColor={borderColor}
                        onChange={(updates) => updateRule(i, updates)}
                        onDelete={() => deleteRule(i)}
                        customIconIds={customIconIds}
                        onImported={(name) =>
                            setStoredIcons((prev) => (prev.includes(name) ? prev : [...prev, name]))
                        }
                        ruleIndex={i}
                    />
                ))}
            </div>

            {/* Live preview — type any command line and see the resolution. */}
            <div className="mt-8 flex flex-col">
                <SectionTitle variant="subsection">{t["Preview"]}</SectionTitle>
                <SettingPreviewInput previewLine={previewLine} setPreviewLine={setPreviewLine} />
                {preview && (
                    <div className="flex flex-row items-center gap-2 mt-3 text-sm text-muted">
                        {preview.icon ? (
                            <AppIcon app={preview.icon} dark={dark} size={32} />
                        ) : preview.ruleIndex < 0 ? (
                            <span>{t["No match - the shell icon is used"]}</span>
                        ) : null}
                        {preview.ruleIndex >= 0 && (
                            <span>
                                {t["Matches rule"]} #{preview.ruleIndex + 1}
                            </span>
                        )}
                        {preview.ruleIndex < 0 && preview.icon && <span>{t["Built-in icon"]}</span>}
                    </div>
                )}
            </div>
        </SettingsShell>
    );
}

/** Isolated so the preview input doesn't re-render the whole rule list on
 * every keystroke. */
function SettingPreviewInput({
    previewLine,
    setPreviewLine,
}: {
    previewLine: string;
    setPreviewLine: (v: string) => void;
}) {
    const t = useI18n();
    return (
        <div className="flex flex-row gap-2 items-baseline justify-start">
            <Label className="mb-2" htmlFor="command-icon-preview">
                {t["Test command:"]}
            </Label>
            <Input
                id="command-icon-preview"
                value={previewLine}
                onChange={(e) => setPreviewLine(e.target.value)}
                className="font-mono max-w-md w-full"
                placeholder="git push origin main"
            />
        </div>
    );
}
