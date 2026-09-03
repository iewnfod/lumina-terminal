import {useCallback, useEffect, useMemo, useState} from "react";
import {Button, Kbd, Label, ListBox, Select} from "@heroui/react";
import {Pencil, Plus, RotateCcw, Trash2, X} from "lucide-react";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useSettingsDraft} from "../../hooks/useSettingsDraft.ts";
import {info} from "@tauri-apps/plugin-log";
import {Actions} from "../../types/config.ts";
import {DEFAULT_BINDINGS} from "../../constants.ts";
import {bindingToShortcut} from "../../lib/bindings.ts";
import {
    ALL_ACTIONS,
    actionLabel,
    detectConflicts,
    detectMissingAccelerator,
    findDefaultFor,
    matchesDefaultBinding,
    stripDraftFlag,
    toDraft,
    type DraftBinding,
} from "../../lib/bindingsSettings.ts";
import {useKeyRecorder} from "../../hooks/useKeyRecorder.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";
import SaveFooter from "../ui/SaveFooter.tsx";
import SettingRow from "../ui/SettingRow.tsx";

// Key used in the "Add binding" action dropdown when no action is chosen yet.
const NO_ACTION = "__none__";
// Sentinel used in the profile picker to mean "the default profile".
const DEFAULT_PROFILE_KEY = "__default_profile__";

export default function BindingsSettings({borderColor}: { borderColor: string }) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();

    const sourceBindings = config.bindings?.length ? config.bindings : DEFAULT_BINDINGS;
    const [recordingIndex, setRecordingIndex] = useState<number | null>(null);
    // New-binding creation state.
    const [newAction, setNewAction] = useState<Actions | typeof NO_ACTION>(NO_ACTION);
    const [newTabIndex, setNewTabIndex] = useState<string>("0");
    // For newTab: DEFAULT_PROFILE_KEY = default profile; otherwise the profile name to open.
    const [newProfileName, setNewProfileName] = useState<string>(DEFAULT_PROFILE_KEY);

    // Shared draft logic (reseed on external config change + isDirty). The
    // draft carries the transient __isDefault flag, so dirtiness compares a
    // normalized (stripped) projection — editing a key away and back to the
    // default reads as clean again, exactly like the previous hand-rolled
    // comparator.
    const {draft, setDraft, isDirty, save} = useSettingsDraft(
        useMemo(() => sourceBindings.map(toDraft), [sourceBindings]),
        (d) => {
            info(`Bindings saved (${d.length} entries)`);
            // Strip the transient __isDefault flag before persisting.
            updateConfig({bindings: d.map(stripDraftFlag)});
        },
        [config.bindings],
        {
            isEqual: (src, d) =>
                JSON.stringify(d.map(stripDraftFlag)) === JSON.stringify(src.map(stripDraftFlag)),
        },
    );

    const conflicts = useMemo(() => detectConflicts(draft), [draft]);
    const hasConflicts = conflicts.size > 0;
    const missingAccelerator = useMemo(() => detectMissingAccelerator(draft), [draft]);
    const hasMissingAccelerator = missingAccelerator.size > 0;

    const updateBinding = useCallback((index: number, updates: Partial<DraftBinding>) => {
        setDraft((prev) => prev.map((b, i) => (i === index ? {...b, ...updates} : b)));
    }, []);

    const stopRecording = useCallback(() => setRecordingIndex(null), []);
    const recordBinding = useCallback((index: number, key: string, withKeys: DraftBinding["with"]) => {
        updateBinding(index, {key, with: withKeys});
    }, [updateBinding]);
    useKeyRecorder(recordingIndex, recordBinding, stopRecording);

    const handleDelete = useCallback((index: number) => {
        setDraft((prev) => {
            const target = prev[index];
            if (!target) return prev;
            // Deleting a default-origin action restores the default key rather
            // than removing the row. User-added bindings (even ones whose action
            // matches a default) are always removed outright.
            if (target.__isDefault) {
                const def = findDefaultFor(target);
                if (def) {
                    return prev.map((b, i) =>
                        i === index ? {...def, __isDefault: matchesDefaultBinding(def)} : b,
                    );
                }
            }
            return prev.filter((_, i) => i !== index);
        });
    }, []);

    const handleAdd = useCallback(() => {
        if (newAction === NO_ACTION) return;
        const action = newAction as Actions;
        let args: Record<string, string> | undefined;
        if (action === "toTab") {
            args = {index: newTabIndex};
        } else if (action === "newTab" && newProfileName && newProfileName !== DEFAULT_PROFILE_KEY) {
            args = {profileName: newProfileName};
        }
        const candidate: DraftBinding = {
            key: "",
            with: [],
            action,
            args,
            __isDefault: false,
        };
        setDraft((prev) => [...prev, candidate]);
        setNewAction(NO_ACTION);
        setNewTabIndex("0");
        setNewProfileName(DEFAULT_PROFILE_KEY);
        // Start recording for the newly added binding.
        setRecordingIndex(-1); // temporary; will be patched once state settles
    }, [newAction, newTabIndex, newProfileName]);

    // After adding, recordingIndex is -1 (sentinel). Resolve to the last index once.
    useEffect(() => {
        if (recordingIndex === -1) {
            setRecordingIndex(draft.length - 1);
        }
    }, [recordingIndex, draft.length]);

    const handleReset = useCallback(() => {
        // "Reset to Defaults" restores the FACTORY bindings (not the last
        // saved ones) — the user then presses Save to persist them.
        setDraft(DEFAULT_BINDINGS.map(toDraft));
        setRecordingIndex(null);
    }, [setDraft]);

    // HeroUI semantic danger token — redefined under .dark so it tracks the
    // theme mode (unlike the old --color-danger-500, which was never defined
    // and silently fell back to a static #ef4444).
    const dangerColor = "var(--danger)";

    return (
        <SettingsShell
            footer={
                <SaveFooter
                    isDisabled={!isDirty || hasConflicts || hasMissingAccelerator}
                    saveLabel={t["Save"]}
                    onPressSave={save}
                    isDirty={isDirty}
                    unsavedLabel={t["Unsaved changes"]}
                    status={hasConflicts ? (
                        <span className="text-xs" style={{color: dangerColor}}>
                            {t["Conflict: this shortcut is already in use"]}
                        </span>
                    ) : hasMissingAccelerator ? (
                        <span className="text-xs" style={{color: dangerColor}}>
                            {t["At least one modifier key is required"]}
                        </span>
                    ) : undefined}
                    trailing={
                        <Button variant="outline" onPress={handleReset}>
                            <RotateCcw size={15}/>
                            {t["Reset to Defaults"]}
                        </Button>
                    }
                    borderColor={borderColor}
                />
            }
        >
            <SectionTitle mb="0.5rem">{t["Keyboard Shortcuts"]}</SectionTitle>
            <p className="text-xs text-muted mb-5">
                {t["Click a shortcut and press the keys you want to use."]}
            </p>

            {/* Add binding row */}
            <div
                className="flex flex-row items-end gap-3 mb-5 px-3"
            >
                <SettingRow className="flex-1 min-w-0 max-w-xs" label={<Label>{t["Action"]}</Label>}>
                    <Select
                        selectedKey={newAction}
                        onSelectionChange={(key) => {
                            if (key) setNewAction(key as Actions);
                        }}
                    >
                        <Select.Trigger>
                            <Select.Value/>
                            <Select.Indicator/>
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                {ALL_ACTIONS.map((a) => (
                                    <ListBox.Item id={a} key={a} textValue={a}>
                                        {actionLabel(a, undefined, t, true)}
                                    </ListBox.Item>
                                ))}
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </SettingRow>

                {newAction === "toTab" && (
                    <SettingRow className="w-28" label={<Label>{t["Switch to Tab"]}</Label>}>
                        <Select
                            selectedKey={newTabIndex}
                            onSelectionChange={(key) => {
                                if (key) setNewTabIndex(key as string);
                            }}
                        >
                            <Select.Trigger>
                                <Select.Value/>
                                <Select.Indicator/>
                            </Select.Trigger>
                            <Select.Popover>
                                <ListBox>
                                    {["0", "1", "2", "3", "4", "5", "6", "7"].map((idx) => (
                                        <ListBox.Item id={idx} key={idx} textValue={idx}>
                                            {t["Tab {n}"].replace("{n}", String(+idx + 1))}
                                        </ListBox.Item>
                                    ))}
                                    <ListBox.Item id="last" key="last" textValue="last">
                                        {t["Last tab"]}
                                    </ListBox.Item>
                                </ListBox>
                            </Select.Popover>
                        </Select>
                    </SettingRow>
                )}

                {newAction === "newTab" && (
                    <SettingRow className="w-44" label={<Label>{t["Profile"]}</Label>}>
                        <Select
                            selectedKey={newProfileName}
                            onSelectionChange={(key) => {
                                if (key) setNewProfileName(key as string);
                            }}
                        >
                            <Select.Trigger>
                                <Select.Value/>
                                <Select.Indicator/>
                            </Select.Trigger>
                            <Select.Popover>
                                <ListBox>
                                    <ListBox.Item id={DEFAULT_PROFILE_KEY} key={DEFAULT_PROFILE_KEY} textValue={DEFAULT_PROFILE_KEY}>
                                        {t["Default Profile"]}
                                    </ListBox.Item>
                                    {config.profiles.map((p) => (
                                        <ListBox.Item id={p.name} key={p.name} textValue={p.name}>
                                            {p.name}
                                        </ListBox.Item>
                                    ))}
                                </ListBox>
                            </Select.Popover>
                        </Select>
                    </SettingRow>
                )}

                <Button
                    variant="outline"
                    isDisabled={newAction === NO_ACTION}
                    onPress={handleAdd}
                >
                    <Plus size={15}/>
                    {t["Add Binding"]}
                </Button>
            </div>

            <div className="flex flex-col gap-2">
                {draft.map((b, i) => {
                    const isRecording = recordingIndex === i;
                    const hasConflict = conflicts.has(i);
                    const isIncomplete = b.key.trim().length === 0 || b.with.length === 0;
                    const isInvalid = hasConflict || isIncomplete;
                    const shortcut = bindingToShortcut(b);

                    return (
                        <div
                            key={`${b.action}-${i}`}
                            className="flex flex-row items-center gap-3 px-3 py-2.5 rounded-md"
                            style={{
                                border: `1px solid ${isInvalid ? dangerColor : borderColor}`,
                                background: isInvalid ? "rgba(239,68,68,0.06)" : "transparent",
                            }}
                        >
                            {/* Action label */}
                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                <span className="text-sm font-medium truncate">
                                    {actionLabel(b.action, b.args, t)}
                                </span>
                                {hasConflict && (
                                    <span className="text-xs" style={{color: dangerColor}}>
                                        {t["Conflict: this shortcut is already in use"]}
                                    </span>
                                )}
                                {isIncomplete && !isRecording && (
                                    <span className="text-xs" style={{color: dangerColor}}>
                                        {b.with.length === 0
                                            ? t["At least one modifier key is required"]
                                            : t["Press keys to record..."]}
                                    </span>
                                )}
                            </div>

                            {/* Shortcut display / recorder */}
                            {isRecording ? (
                                <div
                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm select-none bg-default/10"
                                    style={{
                                        border: `1px solid ${borderColor}`,
                                        minWidth: 140,
                                        justifyContent: "space-between",
                                    }}
                                >
                                    <span className="text-muted">{t["Recording... Esc to cancel"]}</span>
                                    <button
                                        onClick={stopRecording}
                                        className="cursor-pointer text-muted hover:text-foreground shrink-0"
                                        title={t["Cancel"]}
                                    >
                                        <X size={14}/>
                                    </button>
                                </div>
                            ) : (
                                <button
                                    className="flex items-center gap-0.5 px-2.5 py-1.5 rounded-md cursor-pointer shrink-0 hover:bg-default/10"
                                    style={{border: `1px solid ${borderColor}`}}
                                    onClick={() => setRecordingIndex(i)}
                                    title={t["Press keys to record..."]}
                                >
                                    {b.key.trim().length > 0 ? (
                                        shortcut.map((key, j) => (
                                            <Kbd key={j}>
                                                {key.abbr ? (
                                                    // @ts-ignore — keyValue is not typed in heroui
                                                    <Kbd.Abbr keyValue={key.abbr}/>
                                                ) : null}
                                                <Kbd.Content>{key.content}</Kbd.Content>
                                            </Kbd>
                                        ))
                                    ) : (
                                        <Pencil size={14} className="text-muted"/>
                                    )}
                                </button>
                            )}

                            {/* Edit + delete / restore */}
                            {!isRecording && (
                                <div className="flex items-center gap-1 shrink-0">
                                    <button
                                        className="cursor-pointer p-1.5 rounded-md hover:bg-default/10 text-muted"
                                        onClick={() => setRecordingIndex(i)}
                                        title={t["Press keys to record..."]}
                                    >
                                        <Pencil size={15}/>
                                    </button>
                                    <button
                                        className="cursor-pointer p-1.5 rounded-md hover:bg-default/10 text-muted"
                                        onClick={() => handleDelete(i)}
                                        title={b.__isDefault ? t["Restore default"] : t["Delete"]}
                                    >
                                        {b.__isDefault ? (
                                            <RotateCcw size={15}/>
                                        ) : (
                                            <Trash2 size={15}/>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </SettingsShell>
    );
}
