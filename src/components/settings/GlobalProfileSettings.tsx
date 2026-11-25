import {useCallback} from "react";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {TerminalRenderOptions} from "../../types/terminal.ts";
import {info} from "@tauri-apps/plugin-log";
import RenderSettings from "./RenderSettings.tsx";
import {useSettingsDraft} from "../../hooks/useSettingsDraft.ts";
import {withRenderValue, type RenderFieldKey, type RenderValue} from "../../lib/renderOptions.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";
import SaveFooter from "../ui/SaveFooter.tsx";

export default function GlobalProfileSettings({borderColor}: { borderColor: string }) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();

    // The global profile is a partial — fill the structural defaults so the
    // render-options form always has cols/rows to edit.
    const source: TerminalRenderOptions = {cols: 80, rows: 24, ...config.globalProfile};

    const {draft, setDraft, isDirty, save} = useSettingsDraft<TerminalRenderOptions>(
        source,
        (d) => {
            info("Global profile settings saved");
            // Trim empty strings to undefined so they don't serialize as "" in
            // config.toml (matches the original panel's behavior).
            const trimmed: TerminalRenderOptions = JSON.parse(JSON.stringify({
                ...d,
                fontFamily: d.fontFamily?.trim() || undefined,
                fontStyle: d.fontStyle || undefined,
                themePath: d.themePath?.trim() || undefined,
            }));
            updateConfig({globalProfile: trimmed});
        },
        [config.globalProfile],
    );

    // Render fields commit one key at a time (`undefined` = unset), through
    // the same type-safe update the per-profile override list uses.
    const setRenderValue = useCallback(
        (key: RenderFieldKey, value: RenderValue | undefined) =>
            setDraft((prev) => withRenderValue(prev, key, value)),
        [setDraft],
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
                />
            }
        >
            <SectionTitle>{t["Global Profile"]}</SectionTitle>
            <RenderSettings draft={draft} setRenderValue={setRenderValue} idPrefix="gp" />
        </SettingsShell>
    );
}
