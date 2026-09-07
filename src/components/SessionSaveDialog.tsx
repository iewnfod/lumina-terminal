import {useEffect, useMemo, useState, type CSSProperties} from "react";
import {Modal, Button, Switch, Label} from "@heroui/react";
import {motion} from "framer-motion";
import {useI18n} from "../hooks/i18n.tsx";
import {info} from "@tauri-apps/plugin-log";
import {glassSurface, glassBorder, elevationShadow} from "../lib/glass.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {whileHoverTap} from "../lib/motion.ts";

interface SessionSaveDialogProps {
    /** Whether the dialog is shown. */
    open: boolean;
    /** Number of open terminal tabs that would be saved. */
    count: number;
    /** Called with the user's decision + whether to remember it. */
    onResolve: (decision: "save" | "nosave", remember: boolean) => void;
    /** Effective background the dialog floats over (from useEffectiveTheme).
     *  Drives the glass material + derived surface colors so the dialog reads
     *  as part of the same chrome as the tab/title bars. */
    backgroundColor: string;
    /** Effective foreground color (readable contrast for backgroundColor). */
    foregroundColor: string;
}

/**
 * The "Ask every time" close confirmation for session save. Shown when
 * `sessionSaveMode === "ask"` and the user closes a window with open terminal
 * tabs. Two buttons (Save / Don't Save) — no cancel — plus a "remember this
 * choice" switch that, when on, rewrites the mode to always/never so future
 * closes skip the dialog.
 *
 * Wears the same glass + elevation treatment as the command palette
 * (single source for the chrome look, §3.2). The close handler in
 * useSessionPersistence awaits the resolution before destroying the window.
 */
export default function SessionSaveDialog({
    open,
    count,
    onResolve,
    backgroundColor,
    foregroundColor,
}: SessionSaveDialogProps) {
    const t = useI18n();
    const [remember, setRemember] = useState(false);

    // Reset "remember" each time the dialog opens so a previous session's
    // choice doesn't carry over.
    useEffect(() => {
        if (open) {
            setRemember(false);
            info(`Session save dialog shown (${count} tab(s))`);
        }
    }, [open, count]);

    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();
    const glass = useMemo(
        () => glassSurface(backgroundColor, supportsGlass, {blurPx: 24}),
        [backgroundColor, supportsGlass],
    );
    const borderColor = glassBorder(backgroundColor);
    const shadow = elevationShadow("lg");

    const dialogStyle = {
        ...glass,
        color: foregroundColor,
        border: `1px solid ${borderColor}`,
        boxShadow: shadow,
        overflow: "hidden",
    } as CSSProperties;

    const handle = (decision: "save" | "nosave") => {
        onResolve(decision, remember);
    };

    // Modal must NOT be dismissable by backdrop/escape — the user has to pick
    // Save or Don't Save. The window is held open (preventDefault) until they
    // do; closing the modal any other way would leave the window stranded.
    return (
        <Modal.Backdrop isOpen={open} onOpenChange={() => {}} isDismissable={false}>
            <Modal.Container placement="center">
                <Modal.Dialog className="sm:max-w-sm w-full p-0" style={dialogStyle}>
                    <Modal.Header className="px-5 pt-5 pb-2 m-0">
                        <h2 className="text-base font-semibold" style={{color: foregroundColor}}>
                            {t["Save Tabs?"]}
                        </h2>
                    </Modal.Header>
                    <Modal.Body className="px-5 py-2 m-0">
                        <p className="text-sm" style={{color: colors.inactiveText}}>
                            {t["Save your {n} open tab(s) and restore them next time?"].replace("{n}", String(count))}
                        </p>
                        <button
                            type="button"
                            className="flex items-center gap-2.5 mt-1 text-left cursor-pointer select-none rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-glass)] hover:bg-[var(--lum-hover-bg)] px-2 py-1.5 -mx-2"
                            style={{"--lum-hover-bg": colors.hoverOverlay} as CSSProperties}
                            onClick={() => setRemember((r) => !r)}
                        >
                            <Switch isSelected={remember} onChange={(v) => setRemember(v)}>
                                <Switch.Control>
                                    <Switch.Thumb />
                                </Switch.Control>
                            </Switch>
                            <Label className="text-sm cursor-pointer" style={{color: foregroundColor}}>
                                {t["Don't ask this again"]}
                            </Label>
                        </button>
                    </Modal.Body>
                    <Modal.Footer className="px-5 pb-5 pt-3 gap-2">
                        <motion.div {...whileHoverTap} className="inline-flex">
                            <Button variant="secondary" onPress={() => handle("nosave")}>
                                {t["Don't Save"]}
                            </Button>
                        </motion.div>
                        <motion.div {...whileHoverTap} className="inline-flex">
                            <Button variant="primary" onPress={() => handle("save")}>
                                {t["Save"]}
                            </Button>
                        </motion.div>
                    </Modal.Footer>
                </Modal.Dialog>
            </Modal.Container>
        </Modal.Backdrop>
    );
}
