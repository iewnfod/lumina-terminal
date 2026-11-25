import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
} from "react";

/**
 * Settings panel shell — the page-frame shared by every settings sub-page.
 *
 * Replaces the `flex flex-col h-full` + `flex-1 overflow-y-auto pb-4 pl-1 pr-6`
 * + `shrink-0 border-t` triplet that was duplicated verbatim (with minor
 * spacing drift) across GeneralSettings, GlobalProfileSettings,
 * ProfileSettings, BindingsSettings, and DeveloperSettings. The shell renders
 * the scroll region and optionally a footer slot; panels plug their content
 * and footer in as children.
 *
 * The scroll region is a viewport with "content continues" fades: when the
 * panel is taller than the viewport (a short window, a long profile page) the
 * edge that still has content beyond it shades into the page surface. Without
 * that, a control cut by the fold reads as clipped — WebKitGTK's overlay
 * scrollbars are invisible at rest, and when only a few px overflow the
 * thumb nearly fills its track, so the scrollbar alone is no cue. The fade
 * color is the settings surface (`--lum-surface`, set by SettingsPage), at
 * partial opacity so the covered control stays visible.
 */

export interface SettingsShellProps {
    /** Scrollable body content (fields, toggles, etc.). */
    children: ReactNode;
    /** Fixed bottom footer (typically `<SaveFooter>`). Omit for panels with no
     *  save affordance (e.g. DeveloperSettings). */
    footer?: ReactNode;
    /** Horizontal padding on the right; mirrors the original `pr-6`. */
    bodyClassName?: string;
    style?: CSSProperties;
}

export default function SettingsShell({
    children,
    footer,
    bodyClassName = "",
    style,
}: SettingsShellProps) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const [atTop, setAtTop] = useState(true);
    const [atBottom, setAtBottom] = useState(true);

    // Which edges still have content beyond them.
    const syncEdges = useCallback(() => {
        const el = bodyRef.current;
        if (!el) return;
        setAtTop(el.scrollTop <= 0.5);
        setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 0.5);
    }, []);

    // After every render, not just on scroll/resize: a panel's own state
    // change (a row added, a section expanded) is what usually changes the
    // body's scroll height, and it re-renders this shell with it. Layout
    // effect, so the fades are right on the first paint of that change.
    useLayoutEffect(syncEdges);

    // The viewport itself resizing (window resize, maximize) moves the edges
    // without a scroll event or — for a pure resize — a meaningful re-render.
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const observer = new ResizeObserver(syncEdges);
        observer.observe(el);
        return () => observer.disconnect();
    }, [syncEdges]);

    return (
        <div className="flex flex-col h-full" style={style}>
            <div className="relative flex-1 min-h-0">
                <div
                    ref={bodyRef}
                    onScroll={syncEdges}
                    className={`absolute inset-0 overflow-y-auto pb-4 pl-1 pr-6 ${bodyClassName}`}
                >
                    {children}
                </div>
                {!atTop && (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 top-0 h-10"
                        style={{backgroundImage: `linear-gradient(to bottom, ${EDGE_FADE_FROM}, transparent)`}}
                    />
                )}
                {!atBottom && (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-10"
                        style={{backgroundImage: `linear-gradient(to top, ${EDGE_FADE_FROM}, transparent)`}}
                    />
                )}
            </div>
            {footer && <>{footer}</>}
        </div>
    );
}

/** Start color of an edge fade: the surface at three quarters opacity, so a
 *  control cut by the fold is veiled — visibly "continues beyond" — but stays
 *  recognizable instead of being hidden. */
const EDGE_FADE_FROM = "color-mix(in srgb, var(--lum-surface, transparent) 75%, transparent)";
