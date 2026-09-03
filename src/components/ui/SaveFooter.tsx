import type {CSSProperties, ReactNode} from "react";
import {Button} from "@heroui/react";

/**
 * Save footer for settings panels. Encapsulates the "Save (disabled when
 * clean) + Unsaved changes indicator + trailing action" pattern duplicated
 * across GeneralSettings / GlobalProfileSettings / ProfileSettings /
 * BindingsSettings. The trailing slot (e.g. "About", "Reset to Defaults",
 * "Delete Profile") keeps each panel's unique action without re-rolling the
 * footer layout.
 *
 * The top border is drawn with the theme-derived `borderColor` so it follows
 * the effective background like the rest of the chrome.
 */
export interface SaveFooterProps {
    /** Disable the Save button (typically `!isDirty`). */
    isDisabled?: boolean;
    /** Save button label (i18n). */
    saveLabel: string;
    onPressSave: () => void;
    /** When true (and not disabled), show the "unsaved changes" hint. */
    isDirty?: boolean;
    /** Label for the unsaved-changes hint (i18n). */
    unsavedLabel?: string;
    /** Optional status message next to Save, replacing the unsaved hint's
     *  slot when set (e.g. Bindings' conflict / missing-modifier warnings —
     *  callers style it, typically danger-colored). */
    status?: ReactNode;
    /** Optional trailing action(s): About, Reset to Defaults, Delete, etc. */
    trailing?: ReactNode;
    /** Theme-derived top border color. */
    borderColor?: string;
    style?: CSSProperties;
}

export default function SaveFooter({
    isDisabled,
    saveLabel,
    onPressSave,
    isDirty,
    unsavedLabel,
    status,
    trailing,
    borderColor,
    style,
}: SaveFooterProps) {
    return (
        <div
            className="shrink-0 pt-3 ml-1 mr-6"
            style={{borderTop: borderColor ? `1px solid ${borderColor}` : undefined, ...style}}
        >
            <div className="flex items-center gap-3 justify-between">
                <div className="flex items-center gap-3 min-w-0">
                    <Button
                        variant="primary"
                        isDisabled={isDisabled}
                        onPress={onPressSave}
                    >
                        {saveLabel}
                    </Button>
                    {isDirty && !isDisabled && unsavedLabel && !status && (
                        <span className="text-xs text-muted truncate">{unsavedLabel}</span>
                    )}
                    {status}
                </div>
                {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
            </div>
        </div>
    );
}
