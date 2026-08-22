import {useEffect, useState} from "react";
import {error} from "@tauri-apps/plugin-log";
import {AppIconId, customIconName, isCustomIconId} from "../lib/appIcon.ts";
import {customIconSrc, peekCustomIconSrc} from "../lib/commandIconApi.ts";
import {getAppIconSrc} from "../assets/app-icons/index.ts";

interface AppIconProps {
    app: AppIconId;
    /** True when the icon renders on a dark background. The matching SVG
     *  variant (dark-bg vs light-bg) is picked from the asset registry. */
    dark: boolean;
    size?: number;
    className?: string;
}

/**
 * Branded app logo icon, shown in the tab when a recognized app is running.
 * Built-in SVGs live as files under `src/assets/app-icons/<id>/` and are
 * looked up by id + background darkness — so adding an icon needs no change
 * here (see `lib/appIcon.ts` for the command→id mapping and the asset
 * registry for the SVG file convention). `custom:<file>` ids render a
 * user-imported image (single file, no light/dark variants) via the asset
 * protocol.
 *
 * Takes precedence over ShellIcon: when a tab has a running command that maps
 * to a known app, this icon replaces the shell icon.
 */
export default function AppIcon({app, dark, size = 14, className}: AppIconProps) {
    const custom = isCustomIconId(app);
    const customUrl = useCustomIconUrl(custom ? customIconName(app) : null);
    const [failed, setFailed] = useState(false);

    // Reset the broken-image guard when the icon id changes.
    useEffect(() => {
        setFailed(false);
    }, [app]);

    const src = custom ? customUrl : getAppIconSrc(app, dark);
    if (!src || failed) return null; // unknown id or deleted/unreadable file

    return (
        <img
            src={src}
            alt=""
            width={size}
            height={size}
            className={className}
            style={{objectFit: "contain"}}
            draggable={false}
            onError={() => setFailed(true)}
        />
    );
}

/** Bridge the async custom-icon URL resolution to a sync render: seed from
 * the module cache when available, resolve in an effect otherwise. `null`
 * name (built-in icon) short-circuits to null. */
function useCustomIconUrl(name: string | null): string | null {
    const [url, setUrl] = useState<string | null>(() =>
        name ? peekCustomIconSrc(name) : null,
    );

    useEffect(() => {
        if (!name) {
            setUrl(null);
            return;
        }
        const cached = peekCustomIconSrc(name);
        if (cached) {
            setUrl(cached);
            return;
        }
        let live = true;
        customIconSrc(name)
            .then((resolved) => {
                if (live) setUrl(resolved);
            })
            .catch((e) => {
                // Missing/unreadable file — log and render nothing.
                error(`Failed to resolve custom icon ${name}: ${e}`).catch(() => {});
            });
        return () => {
            live = false;
        };
    }, [name]);

    return url;
}
