import {ProfileLauncher, SSHConfig, TerminalProfile} from "../../types/terminal.ts";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {info} from "@tauri-apps/plugin-log";
import {open} from "@tauri-apps/plugin-dialog";
import {Button, Input, Label, ListBox, Select, Switch} from "@heroui/react";
import RenderSettings from "./RenderSettings.tsx";
import ShellSelector from "./ShellSelector.tsx";
import SshFields from "./SshFields.tsx";
import IconPicker from "./IconPicker.tsx";
import {Trash2, Pencil, FolderOpen} from "lucide-react";
import {customIconId, isCustomIconId} from "../../lib/appIcon.ts";
import {listCommandIcons} from "../../lib/commandIconApi.ts";
import {getLauncherDir, syncLaunchersFromConfig} from "../../lib/launcherApi.ts";
import {openInFileManager} from "../../lib/fileManagerApi.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SettingRow from "../ui/SettingRow.tsx";
import SaveFooter from "../ui/SaveFooter.tsx";

export default function ProfileSettings({
    profile,
    onRequestDelete,
    onNameChange,
    borderColor,
    dark,
}: {
    profile?: TerminalProfile;
    onRequestDelete: () => void;
    onNameChange: (newName: string) => void;
    borderColor: string;
    /** Whether the settings surface is dark (picks launcher icon variants). */
    dark: boolean;
}) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();

    // Note: this panel keeps its own draft logic rather than using
    // useSettingsDraft. The draft is `TerminalProfile | null` (profile may be
    // undefined while the sidebar selection is in flight), and the save path
    // has profile-specific concerns (name-rename collision check, ssh field
    // pruning, onNameChange callback) that don't fit the generic hook's
    // single-commit signature. The visual shell/row/footer primitives are
    // still applied for consistency with the other panels.
    const [draft, setDraft] = useState<TerminalProfile | null>(null);

    // Reset draft when profile identity changes
    useEffect(() => {
        if (profile) {
            setDraft({...profile});
        } else {
            setDraft(null);
        }
    }, [profile?.name]);

    const isDirty = useMemo(() => {
        if (!profile || !draft) return false;
        return JSON.stringify(profile) !== JSON.stringify(draft);
    }, [profile, draft]);

    const updateDraft = (updates: Partial<TerminalProfile>) => {
        setDraft((prev) => (prev ? {...prev, ...updates} : null));
    };

    const updateSsh = (updates: Partial<SSHConfig>) => {
        setDraft((prev) => {
            if (!prev) return null;
            const ssh = {...prev.ssh, ...updates} as SSHConfig;
            return {...prev, ssh};
        });
    };

    const [isEditingName, setIsEditingName] = useState(false);
    const nameInputRef = useRef<HTMLInputElement>(null);

    // All stored custom icon files — the launcher icon picker's source of
    // truth (same flow as the command-icon rules panel).
    const [storedIcons, setStoredIcons] = useState<string[]>([]);
    useEffect(() => {
        listCommandIcons()
            .then((names) => setStoredIcons(names))
            .catch(() => {
                // logged in the wrapper
            });
    }, []);

    const updateLauncher = (updates: Partial<ProfileLauncher>) => {
        setDraft((prev) =>
            prev ? {...prev, launcher: {...prev.launcher, ...updates}} : null,
        );
    };

    // Stored custom icons (as `custom:` ids) plus any the draft references.
    const customIconIds = useMemo(() => {
        const ids = [
            ...storedIcons.map(customIconId),
            ...(draft?.launcher?.icon && isCustomIconId(draft.launcher.icon)
                ? [draft.launcher.icon]
                : []),
        ];
        return [...new Set(ids)];
    }, [storedIcons, draft?.launcher?.icon]);

    const toggleLauncher = (enabled: boolean) => {
        updateDraft({launcher: enabled ? {} : undefined});
    };

    const revealLauncherDir = useCallback(() => {
        getLauncherDir()
            .then((dir) => openInFileManager(dir))
            .catch(() => {
                // logged in the wrappers
            });
    }, []);

    // Auto-focus name input when entering edit mode
    useEffect(() => {
        if (isEditingName && nameInputRef.current) {
            nameInputRef.current.select();
        }
    }, [isEditingName]);

    if (!profile || !draft) {
        return (
            <div className="flex items-center justify-center h-full text-muted text-sm">
                {t["Profile not found."]}
            </div>
        );
    }

    const profileType = draft.type ?? "local";

    const handleSave = () => {
        if (!draft) return;
        const oldName = profile.name;
        info(`Profile saved: ${oldName}`);
        // Build trimmed profile — omitted undefined keys won't override globalProfile.
        const trimmed: TerminalProfile = JSON.parse(JSON.stringify({
            ...draft,
            name: draft.name.trim(),
            exePath: draft.exePath.trim(),
            fontFamily: draft.fontFamily?.trim() || undefined,
            fontStyle: draft.fontStyle || undefined,
            themePath: draft.themePath?.trim() || undefined,
            startupCommand: draft.startupCommand?.trim() || undefined,
            keepAfterExit: draft.startupCommand?.trim() ? draft.keepAfterExit : undefined,
            type: draft.type ?? "local",
            ssh: draft.type === "remote" ? draft.ssh : undefined,
            // Keep the launcher section lean: empty fields drop to defaults.
            // Presence of the (possibly empty) object still enables it.
            launcher: draft.launcher ? {
                title: draft.launcher.title?.trim() || undefined,
                workingDirectory: draft.launcher.workingDirectory?.trim() || undefined,
                sidebar: draft.launcher.sidebar,
                icon: draft.launcher.icon?.trim() || undefined,
            } : undefined,
        }));
        const newName = trimmed.name;
        if (!newName) return;

        // Check name collision (only if name changed and collides with another profile)
        if (newName !== oldName && config.profiles.some((p) => p.name === newName)) {
            return;
        }

        const newProfiles = config.profiles.map((p) =>
            p.name === oldName ? trimmed : p,
        );
        updateConfig({profiles: newProfiles});
        // Once the config is committed, regenerate the profile launchers
        // (all of them, so renames/deletes elsewhere self-heal too). The
        // empty spec list when nothing uses the feature prunes leftovers.
        syncLaunchersFromConfig({profiles: newProfiles, commandIcons: config.commandIcons});
        if (newName !== oldName) {
            onNameChange(newName);
        }
    };

    return (
        <SettingsShell
            footer={
                <SaveFooter
                    isDisabled={!isDirty}
                    saveLabel={t["Save"]}
                    onPressSave={handleSave}
                    isDirty={isDirty}
                    unsavedLabel={t["Unsaved changes"]}
                    borderColor={borderColor}
                    trailing={
                        <Button
                            variant="outline"
                            onPress={onRequestDelete}
                            className="text-danger border-danger/30 hover:bg-danger/10"
                        >
                            <Trash2 size={15} />
                            {t["Delete Profile"]}
                        </Button>
                    }
                />
            }
        >
            {isEditingName ? (
                <input
                    ref={nameInputRef}
                    type="text"
                    value={draft.name}
                    onChange={(e) => updateDraft({name: e.target.value})}
                    onBlur={() => setIsEditingName(false)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") setIsEditingName(false);
                        if (e.key === "Escape") {
                            updateDraft({name: profile.name});
                            setIsEditingName(false);
                        }
                    }}
                    className="text-lg font-semibold mb-6 bg-transparent border-b outline-none w-full max-w-xs"
                    style={{borderColor, color: "inherit"}}
                />
            ) : (
                <h2
                    className="group lum-title-row flex items-center gap-2 text-lg font-semibold mb-6 cursor-pointer select-none"
                    onDoubleClick={() => setIsEditingName(true)}
                    title={t["Click the pencil or double-click to rename"]}
                >
                    <span className="truncate">{draft.name}</span>
                    <button
                        type="button"
                        // The edit button is the visible affordance for rename;
                        // double-click on the title still works for power users.
                        // Appears on hover (opacity-0 → group-hover:opacity-100).
                        className="lum-title-edit opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-glass)] p-1 rounded-[var(--radius-xs)] hover:bg-[var(--lum-title-hover)] cursor-pointer"
                        style={{"--lum-title-hover": "rgba(128,128,128,0.18)"} as React.CSSProperties}
                        onClick={() => setIsEditingName(true)}
                        aria-label={t["Rename"]}
                    >
                        <Pencil size={14} className="text-muted" />
                    </button>
                </h2>
            )}

            <div className="flex flex-col gap-4">
                {/* Profile Type */}
                <SettingRow label={<Label>{t["Profile Type"]}</Label>}>
                    <Select
                        selectedKey={profileType}
                        onSelectionChange={(key) => {
                            const newType = key as "local" | "remote";
                            updateDraft({
                                type: newType,
                                ssh: newType === "remote" ? (draft.ssh ?? {host: "", port: 22}) : undefined,
                            });
                        }}
                        className="max-w-sm"
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                <ListBox.Item id="local" key="local" textValue="Local">
                                    {t["Local"]}
                                </ListBox.Item>
                                <ListBox.Item id="remote" key="remote" textValue="Remote (SSH)">
                                    {t["Remote (SSH)"]}
                                </ListBox.Item>
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </SettingRow>

                {/* Exe Path (only for local) */}
                {profileType === "local" && (
                    <ShellSelector
                        exePath={draft.exePath}
                        onChange={(path) => updateDraft({exePath: path})}
                        idPrefix="profile"
                    />
                )}

                {/* Startup Directory */}
                <SettingRow label={<Label htmlFor="profile-cwd">{t["Startup Directory"]}</Label>}>
                    <div className="flex flex-row gap-2 items-center">
                        <Input
                            id="profile-cwd"
                            value={draft.cwd ?? ""}
                            onChange={(e) => updateDraft({cwd: e.target.value || undefined})}
                            className="flex-1 max-w-sm"
                            placeholder={t["Default"]}
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            onPress={async () => {
                                const dir = await open({
                                    multiple: false,
                                    directory: true,
                                });
                                if (dir) updateDraft({cwd: dir});
                            }}
                        >
                            {t["Select"]}
                        </Button>
                    </div>
                </SettingRow>

                {/* Startup Command */}
                <SettingRow label={<Label htmlFor="profile-startup-command">{t["Startup Command"]}</Label>}>
                    <Input
                        id="profile-startup-command"
                        value={draft.startupCommand ?? ""}
                        onChange={(e) => updateDraft({startupCommand: e.target.value || undefined})}
                        className="max-w-sm"
                        placeholder={profileType === "remote" ? "e.g. top" : "e.g. vim, opencode"}
                    />
                </SettingRow>

                {/* On Command Exit — only meaningful when a startup command
                    is set. Decides what happens after it finishes: close the
                    tab (default), freeze the output for reading, or drop into
                    an interactive shell so the user can keep working. */}
                {draft.startupCommand?.trim() && (
                    <SettingRow
                        label={<Label>{t["On Command Exit"]}</Label>}
                        description={t["What happens after the startup command finishes"]}
                    >
                        <Select
                            selectedKey={draft.keepAfterExit ?? "exit"}
                            onSelectionChange={(key) => {
                                if (key) {
                                    updateDraft({keepAfterExit: key as "exit" | "shell" | "freeze"});
                                }
                            }}
                            className="max-w-sm"
                        >
                            <Select.Trigger>
                                <Select.Value />
                                <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                                <ListBox>
                                    <ListBox.Item id="exit" key="exit" textValue="exit">
                                        {t["Close on Exit"]}
                                    </ListBox.Item>
                                    <ListBox.Item id="freeze" key="freeze" textValue="freeze">
                                        {t["Freeze Output"]}
                                    </ListBox.Item>
                                    <ListBox.Item id="shell" key="shell" textValue="shell">
                                        {t["Drop to Shell"]}
                                    </ListBox.Item>
                                </ListBox>
                            </Select.Popover>
                        </Select>
                    </SettingRow>
                )}

                {/* SSH Config Fields */}
                {profileType === "remote" && (
                    <SshFields
                        ssh={draft.ssh}
                        onChange={updateSsh}
                        idPrefix="ssh"
                    />
                )}

                {/* Wrap as App — generate a desktop launcher that opens this
                    profile in its own window. Regenerated on every save via
                    lib/launcherApi.ts; see types/terminal.ts ProfileLauncher. */}
                <SettingRow
                    variant="toggle"
                    label={<Label>{t["Wrap as App"]}</Label>}
                    description={t["wrap as app description"]}
                    onClick={() => toggleLauncher(!draft.launcher)}
                >
                    <Switch isSelected={!!draft.launcher} onChange={toggleLauncher}>
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                    </Switch>
                </SettingRow>

                {draft.launcher && (
                    <div
                        className="flex flex-col gap-4 rounded-[var(--radius-sm)] border p-3"
                        style={{borderColor}}
                    >
                        <SettingRow label={<Label htmlFor="launcher-title">{t["Launcher Title"]}</Label>}>
                            <Input
                                id="launcher-title"
                                value={draft.launcher.title ?? ""}
                                onChange={(e) => updateLauncher({title: e.target.value || undefined})}
                                className="max-w-sm"
                                placeholder={draft.name}
                            />
                        </SettingRow>

                        <SettingRow label={<Label htmlFor="launcher-working-directory">{t["Launcher Working Directory"]}</Label>}>
                            <div className="flex flex-row gap-2 items-center">
                                <Input
                                    id="launcher-working-directory"
                                    value={draft.launcher.workingDirectory ?? ""}
                                    onChange={(e) => updateLauncher({workingDirectory: e.target.value || undefined})}
                                    className="flex-1 max-w-sm"
                                    placeholder={t["Default"]}
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onPress={async () => {
                                        const dir = await open({
                                            multiple: false,
                                            directory: true,
                                        });
                                        if (dir) updateLauncher({workingDirectory: dir});
                                    }}
                                >
                                    {t["Select"]}
                                </Button>
                            </div>
                        </SettingRow>

                        <SettingRow label={<Label>{t["Launcher Sidebar"]}</Label>}>
                            <Select
                                selectedKey={draft.launcher.sidebar ?? "hide"}
                                onSelectionChange={(key) => {
                                    if (key) {
                                        updateLauncher({sidebar: key as "show" | "hide"});
                                    }
                                }}
                                className="max-w-sm"
                            >
                                <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                    <ListBox>
                                        <ListBox.Item id="hide" key="hide" textValue="hide">
                                            {t["Hide"]}
                                        </ListBox.Item>
                                        <ListBox.Item id="show" key="show" textValue="show">
                                            {t["Show"]}
                                        </ListBox.Item>
                                    </ListBox>
                                </Select.Popover>
                            </Select>
                        </SettingRow>

                        <SettingRow
                            label={<Label>{t["Launcher Icon"]}</Label>}
                            description={t["launcher icon description"]}
                        >
                            <IconPicker
                                selected={draft.launcher.icon ?? ""}
                                onPick={(id) => updateLauncher({icon: id || undefined})}
                                dark={dark}
                                customIconIds={customIconIds}
                                onImported={(name) =>
                                    setStoredIcons((prev) =>
                                        prev.includes(name) ? prev : [...prev, name],
                                    )
                                }
                                autoLabel={t["Auto (follow the startup command)"]}
                            />
                        </SettingRow>

                        <SettingRow
                            variant="action"
                            label={<Label>{t["Launcher Location"]}</Label>}
                            description={t["launcher location description"]}
                        >
                            <Button variant="outline" size="sm" onPress={revealLauncherDir}>
                                <FolderOpen size={14} />
                                {t["Open Folder"]}
                            </Button>
                        </SettingRow>
                    </div>
                )}

                <RenderSettings draft={draft} updateDraft={updateDraft} idPrefix="profile" defaultExpanded={false} />
            </div>
        </SettingsShell>
    );
}
