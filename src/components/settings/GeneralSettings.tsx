import {useGlobalConfig} from "../../hooks/config.tsx";
import {languageNames, useI18n} from "../../hooks/i18n.tsx";
import {useMemo} from "react";
import {info} from "@tauri-apps/plugin-log";
import {Label, ListBox, Select, Switch, Tooltip} from "@heroui/react";
import {isMacOS} from "../../lib/platform.ts";
import {useIsWayland} from "../../hooks/useIsWayland.ts";
import {useSettingsDraft} from "../../hooks/useSettingsDraft.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SettingRow from "../ui/SettingRow.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";
import SaveFooter from "../ui/SaveFooter.tsx";

interface GeneralDraft {
    language: "en-us" | "zh-cn";
    showTabBar: boolean;
    closeWindowOnLastTab: boolean;
    defaultProfile: string;
    copyWithCtrl: boolean;
    themeMode: "system" | "terminal" | "light" | "dark";
    enableColorSpread: boolean;
    autoUpdateOnStartup: boolean;
    inheritWorkingDirectory: boolean;
    imeDuplicateInputFix: boolean;
    rememberWindowPosition: boolean;
    rememberWindowSize: boolean;
    sessionSaveMode: "never" | "always" | "ask";
    sessionSaveScrollback: boolean;
}

/** Theme-mode options shown in the Select below. Kept here (near the only
 *  consumer) rather than in constants.ts because the ids + labels are purely a
 *  settings-UI concern. Order is the display order. */
const THEME_MODES = ["system", "terminal", "light", "dark"] as const;

/** Session-save mode options shown in the Select below. Same convention as
 *  THEME_MODES: kept local to the only consumer. */
const SESSION_SAVE_MODES = ["never", "always", "ask"] as const;

export default function GeneralSettings({borderColor, openAbout}: {borderColor: string, openAbout: () => void}) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();
    // Wayland can't know or set absolute window position, so the "remember
    // window position" toggle is hidden there (it would be a no-op that
    // confuses users). Size still works on every platform.
    const isWayland = useIsWayland();

    const currentDefault = useMemo(() => {
        return config.profiles.find(p => p.default)?.name ?? config.profiles[0]?.name ?? "";
    }, [config.profiles]);

    const source: GeneralDraft = {
        language: config.language,
        showTabBar: config.showTabBar ?? false,
        closeWindowOnLastTab: config.closeWindowOnLastTab !== false,
        defaultProfile: currentDefault,
        copyWithCtrl: config.copyWithCtrl ?? false,
        themeMode: config.themeMode ?? "terminal",
        enableColorSpread: config.enableColorSpread !== false,
        autoUpdateOnStartup: config.autoUpdateOnStartup !== false,
        inheritWorkingDirectory: config.inheritWorkingDirectory ?? false,
        imeDuplicateInputFix: config.imeDuplicateInputFix !== false,
        rememberWindowPosition: config.rememberWindowPosition ?? false,
        rememberWindowSize: config.rememberWindowSize ?? false,
        sessionSaveMode: config.sessionSaveMode ?? "ask",
        sessionSaveScrollback: config.sessionSaveScrollback ?? false,
    };

    const {draft, setDraft, isDirty, save} = useSettingsDraft<GeneralDraft>(
        source,
        (d) => {
            info("General settings saved");
            const updated: Partial<typeof config> = {
                language: d.language,
                showTabBar: d.showTabBar,
                closeWindowOnLastTab: d.closeWindowOnLastTab,
                copyWithCtrl: d.copyWithCtrl,
                themeMode: d.themeMode,
                enableColorSpread: d.enableColorSpread,
                autoUpdateOnStartup: d.autoUpdateOnStartup,
                inheritWorkingDirectory: d.inheritWorkingDirectory,
                imeDuplicateInputFix: d.imeDuplicateInputFix,
                rememberWindowPosition: d.rememberWindowPosition,
                rememberWindowSize: d.rememberWindowSize,
                sessionSaveMode: d.sessionSaveMode,
                sessionSaveScrollback: d.sessionSaveScrollback,
            };
            // Default-profile change rewrites the profiles array (only one may
            // be default at a time), so apply it here rather than via a flat
            // config field.
            if (d.defaultProfile !== currentDefault) {
                updated.profiles = config.profiles.map(p => ({
                    ...p,
                    default: p.name === d.defaultProfile ? true : p.default ? false : undefined,
                }));
            }
            updateConfig(updated);
        },
        [config.language, config.showTabBar, config.closeWindowOnLastTab, config.copyWithCtrl, config.themeMode, config.enableColorSpread, config.autoUpdateOnStartup, config.inheritWorkingDirectory, config.imeDuplicateInputFix, config.rememberWindowPosition, config.rememberWindowSize, config.sessionSaveMode, config.sessionSaveScrollback, currentDefault],
    );

    return (
        <SettingsShell
            footer={
                <SaveFooter
                    isDisabled={!isDirty}
                    saveLabel={t["Save"]}
                    onPressSave={save}
                    isDirty={isDirty}
                    unsavedLabel={t["Unsaved changes"]}
                    borderColor={borderColor}
                    trailing={
                        <button
                            className="cursor-pointer text-sm px-3 py-1.5 rounded-[var(--radius-sm)] border transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-outline-hover)]"
                            style={{borderColor, ["--lum-outline-hover" as string]: "rgba(128,128,128,0.12)"}}
                            onClick={openAbout}
                        >
                            {t["About"]} Lumina Terminal
                        </button>
                    }
                />
            }
        >
            <SectionTitle>{t["General"]}</SectionTitle>

            {/* The settings are grouped into related subsections so the page
                stays scannable as more options are added. Each subsection has
                its own heading (variant="subsection") and a column of rows;
                groups are separated by a larger gap than the rows within. */}
            <div className="flex flex-col gap-8">
                {/* Basics — language, default profile, update checks. */}
                <section>
                    <SectionTitle variant="subsection">{t["Basics"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        <div className="flex flex-col lg:flex-row gap-5">
                            {/* Language */}
                            <SettingRow label={<Label>{t["Language"]}</Label>}>
                                <Select
                                    selectedKey={draft.language}
                                    onSelectionChange={(key) => {
                                        if (key) {
                                            setDraft((prev) => ({...prev, language: key as "en-us" | "zh-cn"}));
                                        }
                                    }}
                                >
                                    <Select.Trigger>
                                        <Select.Value />
                                        <Select.Indicator />
                                    </Select.Trigger>
                                    <Select.Popover>
                                        <ListBox>
                                            {[...languageNames.keys()].map((lang) => (
                                                <ListBox.Item id={lang} key={lang} textValue={lang}>
                                                    {languageNames.get(lang)}
                                                </ListBox.Item>
                                            ))}
                                        </ListBox>
                                    </Select.Popover>
                                </Select>
                            </SettingRow>

                            {/* Default Profile */}
                            <SettingRow label={<Label>{t["Default Profile"]}</Label>}>
                                <Select
                                    selectedKey={draft.defaultProfile}
                                    onSelectionChange={(key) => {
                                        if (key) {
                                            setDraft((prev) => ({...prev, defaultProfile: key as string}));
                                        }
                                    }}
                                >
                                    <Select.Trigger>
                                        <Select.Value />
                                        <Select.Indicator />
                                    </Select.Trigger>
                                    <Select.Popover>
                                        <ListBox>
                                            {config.profiles.map((p) => (
                                                <ListBox.Item id={p.name} key={p.name} textValue={p.name}>
                                                    {p.name}
                                                </ListBox.Item>
                                            ))}
                                        </ListBox>
                                    </Select.Popover>
                                </Select>
                            </SettingRow>
                        </div>

                        {/* Auto-check for updates on startup */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Auto-check for updates on startup"]}</Label>}
                            description={t["Check for available updates when the app starts"]}
                            onClick={() => setDraft((prev) => ({...prev, autoUpdateOnStartup: !prev.autoUpdateOnStartup}))}
                        >
                            <Switch
                                isSelected={draft.autoUpdateOnStartup}
                                onChange={(v) => setDraft((prev) => ({...prev, autoUpdateOnStartup: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>

                {/* Appearance — how the app's light/dark rendering is decided. */}
                <section>
                    <SectionTitle variant="subsection">{t["Appearance"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        {/* Theme Mode: how the app's light/dark appearance is
                            decided. Controls only rendering (text/icons/glass);
                            the background color still follows the terminal/TUI. */}
                        <SettingRow
                            label={<Label>{t["Theme Mode"]}</Label>}
                            description={t["Decide light/dark appearance: follow the OS, the terminal background, or force one"]}
                        >
                            <Select
                                selectedKey={draft.themeMode}
                                onSelectionChange={(key) => {
                                    if (key) {
                                        setDraft((prev) => ({...prev, themeMode: key as GeneralDraft["themeMode"]}));
                                    }
                                }}
                            >
                                <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                    <ListBox>
                                        {THEME_MODES.map((mode) => (
                                            <ListBox.Item id={mode} key={mode} textValue={mode}>
                                                {themeModeLabel(mode, t)}
                                            </ListBox.Item>
                                        ))}
                                    </ListBox>
                                </Select.Popover>
                            </Select>
                        </SettingRow>

                        {/* Color spread: let a fullscreen TUI's background bleed
                            to the window edges. */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Color Spread"]}</Label>}
                            description={t["Let fullscreen apps' background fill the whole window"]}
                            onClick={() => setDraft((prev) => ({...prev, enableColorSpread: !prev.enableColorSpread}))}
                        >
                            <Switch
                                isSelected={draft.enableColorSpread}
                                onChange={(v) => setDraft((prev) => ({...prev, enableColorSpread: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>

                {/* Window — restore main-window position/size on startup. */}
                <section>
                    <SectionTitle variant="subsection">{t["Window"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        {/* Remember Window Position. Shown but disabled under
                            Wayland: the compositor forbids knowing/setting
                            absolute position, so the toggle would be a no-op.
                            Instead of hiding it we gray the row out and wrap it
                            in a Tooltip (mirroring the pin button) so users
                            learn *why* it's unavailable rather than wondering
                            where it went. Non-Wayland: a plain, clickable row. */}
                        {(() => {
                            const row = (
                                <SettingRow
                                    variant="toggle"
                                    label={<Label className={isWayland ? "cursor-not-allowed opacity-50" : "cursor-pointer"}>{t["Remember Window Position"]}</Label>}
                                    description={t["Restore the window to its last position on startup"]}
                                    onClick={() => {
                                        if (isWayland) return;
                                        setDraft((prev) => ({...prev, rememberWindowPosition: !prev.rememberWindowPosition}));
                                    }}
                                >
                                    <Switch
                                        isSelected={draft.rememberWindowPosition}
                                        isDisabled={isWayland}
                                        onChange={(v) => setDraft((prev) => ({...prev, rememberWindowPosition: v}))}
                                    >
                                        <Switch.Control>
                                            <Switch.Thumb />
                                        </Switch.Control>
                                    </Switch>
                                </SettingRow>
                            );
                            return isWayland ? (
                                <Tooltip delay={300} closeDelay={0}>
                                    {/* The disabled Switch dispatches no pointer
                                        events of its own, so wrap the whole row
                                        to keep the tooltip hover target alive. */}
                                    <Tooltip.Trigger>
                                        <span className="block">{row}</span>
                                    </Tooltip.Trigger>
                                    <Tooltip.Content>
                                        <p className="text-xs">{t["Remembering window position is not supported on Wayland"]}</p>
                                    </Tooltip.Content>
                                </Tooltip>
                            ) : row;
                        })()}

                        {/* Remember Window Size */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Remember Window Size"]}</Label>}
                            description={t["Restore the window to its last size on startup"]}
                            onClick={() => setDraft((prev) => ({...prev, rememberWindowSize: !prev.rememberWindowSize}))}
                        >
                            <Switch
                                isSelected={draft.rememberWindowSize}
                                onChange={(v) => setDraft((prev) => ({...prev, rememberWindowSize: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>

                {/* Tabs — sidebar visibility and the last-tab-close policy. */}
                <section>
                    <SectionTitle variant="subsection">{t["Tabs"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        {/* Show Tab Bar */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Show Tab Bar"]}</Label>}
                            onClick={() => setDraft((prev) => ({...prev, showTabBar: !prev.showTabBar}))}
                        >
                            <Switch
                                isSelected={draft.showTabBar}
                                onChange={(v) => setDraft((prev) => ({...prev, showTabBar: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>

                        {/* Close Window on Last Tab */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Close Window on Last Tab Closed"]}</Label>}
                            onClick={() => setDraft((prev) => ({...prev, closeWindowOnLastTab: !prev.closeWindowOnLastTab}))}
                        >
                            <Switch
                                isSelected={draft.closeWindowOnLastTab}
                                onChange={(v) => setDraft((prev) => ({...prev, closeWindowOnLastTab: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>

                {/* Sessions — whether open tabs are saved on exit and restored. */}
                <section>
                    <SectionTitle variant="subsection">{t["Sessions"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        {/* Session Restore: whether open tabs are saved on exit
                            and restored on next launch. See lib/session.ts. */}
                        <SettingRow
                            label={<Label>{t["Save Tabs on Exit"]}</Label>}
                            description={t["Choose what happens to your open tabs when quitting Lumina"]}
                        >
                            <Select
                                selectedKey={draft.sessionSaveMode}
                                onSelectionChange={(key) => {
                                    if (key) {
                                        setDraft((prev) => ({...prev, sessionSaveMode: key as GeneralDraft["sessionSaveMode"]}));
                                    }
                                }}
                            >
                                <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                    <ListBox>
                                        {SESSION_SAVE_MODES.map((mode) => (
                                            <ListBox.Item id={mode} key={mode} textValue={mode}>
                                                {sessionSaveModeLabel(mode, t)}
                                            </ListBox.Item>
                                        ))}
                                    </ListBox>
                                </Select.Popover>
                            </Select>
                        </SettingRow>

                        {/* Save Terminal History (scrollback): only meaningful
                            when a save actually happens. Disabled when mode is
                            "never" so the toggle can't be left on with no
                            effect. */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className={draft.sessionSaveMode === "never" ? "cursor-pointer opacity-50" : "cursor-pointer"}>{t["Save Terminal History"]}</Label>}
                            description={t["Replay each tab's scrollback when restoring (increases session file size)"]}
                            onClick={() => {
                                if (draft.sessionSaveMode === "never") return;
                                setDraft((prev) => ({...prev, sessionSaveScrollback: !prev.sessionSaveScrollback}));
                            }}
                        >
                            <Switch
                                isSelected={draft.sessionSaveScrollback}
                                isDisabled={draft.sessionSaveMode === "never"}
                                onChange={(v) => setDraft((prev) => ({...prev, sessionSaveScrollback: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>

                {/* Behavior — per-keystroke conventions new terminals follow. */}
                <section>
                    <SectionTitle variant="subsection">{t["Behavior"]}</SectionTitle>
                    <div className="flex flex-col gap-5">
                        {/* Copy with Ctrl+C (non-macOS only) */}
                        {!isMacOS() && (
                            <SettingRow
                                variant="toggle"
                                label={<Label className="cursor-pointer">{t["Copy with Ctrl+C"]}</Label>}
                                description={t["Swap Ctrl+C and Ctrl+Shift+C for copy and interrupt on non-macOS systems"]}
                                onClick={() => setDraft((prev) => ({...prev, copyWithCtrl: !prev.copyWithCtrl}))}
                            >
                                <Switch
                                    isSelected={draft.copyWithCtrl}
                                    onChange={(v) => setDraft((prev) => ({...prev, copyWithCtrl: v}))}
                                >
                                    <Switch.Control>
                                        <Switch.Thumb />
                                    </Switch.Control>
                                </Switch>
                            </SettingRow>
                        )}

                        {/* Inherit Working Directory: new tabs start in the
                            active terminal's current directory instead of the
                            profile default, so users can hop between
                            shells/profiles without re-`cd`'ing. */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["Inherit Working Directory"]}</Label>}
                            description={t["New terminals start in the active terminal's current directory"]}
                            onClick={() => setDraft((prev) => ({...prev, inheritWorkingDirectory: !prev.inheritWorkingDirectory}))}
                        >
                            <Switch
                                isSelected={draft.inheritWorkingDirectory}
                                onChange={(v) => setDraft((prev) => ({...prev, inheritWorkingDirectory: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>

                        {/* IME Duplicate Input Fix: normalize WebKitGTK/IBus IME
                            commits that arrive without a matching
                            compositionstart so text isn't sent twice. The guard
                            rewrites the textarea on each such commit — if that
                            costs IME responsiveness, opting out restores the
                            raw xterm behavior (input may duplicate again on
                            Linux). */}
                        <SettingRow
                            variant="toggle"
                            label={<Label className="cursor-pointer">{t["IME Duplicate Input Fix"]}</Label>}
                            description={t["Prevent duplicated IME input on Linux; turn off if IME input feels slow"]}
                            onClick={() => setDraft((prev) => ({...prev, imeDuplicateInputFix: !prev.imeDuplicateInputFix}))}
                        >
                            <Switch
                                isSelected={draft.imeDuplicateInputFix}
                                onChange={(v) => setDraft((prev) => ({...prev, imeDuplicateInputFix: v}))}
                            >
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                        </SettingRow>
                    </div>
                </section>
            </div>
        </SettingsShell>
    );
}

/** Map a theme-mode id to its localized display name for the Select. */
function themeModeLabel(mode: "system" | "terminal" | "light" | "dark", t: ReturnType<typeof useI18n>): string {
    switch (mode) {
        case "system": return t["Follow System"];
        case "terminal": return t["Follow Terminal"];
        case "light": return t["Always Light"];
        case "dark": return t["Always Dark"];
    }
}

/** Map a session-save mode id to its localized display name for the Select. */
function sessionSaveModeLabel(mode: "never" | "always" | "ask", t: ReturnType<typeof useI18n>): string {
    switch (mode) {
        case "never": return t["Never"];
        case "always": return t["Always"];
        case "ask": return t["Ask Every Time"];
    }
}
