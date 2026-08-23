import type {CSSProperties} from "react";
import {motion} from "framer-motion";
import {Button, Modal} from "@heroui/react";
import {useI18n} from "../hooks/i18n.tsx";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {whileHoverTap} from "../lib/motion.ts";
import {openExternal} from "../lib/openerApi.ts";
import {categoryLabel, type TechGroup} from "../lib/techStack.ts";

interface TechStackModalProps {
    /** Whether the modal is shown. */
    open: boolean;
    /** Toggles with the backdrop/escape dismiss. */
    onOpenChange: (open: boolean) => void;
    /** Grouped tech items parsed from README's "Technology Used" section. */
    groups: TechGroup[];
    /** Effective background color (drives the derived card surface colors). */
    backgroundColor: string;
    /** Effective foreground color (readable contrast for the page background). */
    foregroundColor: string;
}

/**
 * Lists the technologies used by Lumina as a card grid, grouped by category,
 * in a scrollable modal. Each card is a link (name + optional description)
 * tinted from the page background via {@link useSurfaceColors}, so it reads as
 * part of the same chrome. The data comes from README.md via
 * {@link parseTechStack} (single source of truth); category headings are
 * localized through {@link categoryLabel}.
 *
 * Mirrors the release-notes modal on the same page (Modal.Backdrop blur +
 * Header/Body/Footer) so the two modals read as one.
 */
export default function TechStackModal({
    open,
    onOpenChange,
    groups,
    backgroundColor,
    foregroundColor,
}: TechStackModalProps) {
    const t = useI18n();
    const colors = useSurfaceColors(backgroundColor);

    // Card surface tokens, hoisted as CSS vars on the body wrapper so every card
    // shares one definition and hover can swap the whole background cleanly
    // (inline `background` would win over a hover class — vars avoid that).
    const cardVars = {
        "--lum-card-bg": colors.hoverOverlay,
        "--lum-card-bg-hover": colors.activeOverlay,
        "--lum-card-border": colors.borderColor,
    } as CSSProperties;

    return (
        <Modal.Backdrop
            isOpen={open}
            onOpenChange={onOpenChange}
            isDismissable={true}
            variant="blur"
        >
            <Modal.Container placement="center">
                <Modal.Dialog className="sm:max-w-lg w-full">
                    <Modal.Header>
                        <h2 className="text-lg font-semibold px-3 pb-2">
                            {t["Technology Stack"]}
                        </h2>
                    </Modal.Header>
                    <Modal.Body className="max-h-96 overflow-y-auto px-3 pb-2">
                        <div style={cardVars}>
                            {groups.map((group) => (
                                <div key={group.category} className="first:mt-0 mt-5">
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
                                        {categoryLabel(group.category, t)}
                                    </h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        {group.items.map((item) => (
                                        <motion.a
                                            key={item.url}
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                openExternal(item.url);
                                            }}
                                            {...whileHoverTap}
                                            className="group relative flex flex-col gap-0.5 p-2.5 rounded-[var(--radius-md)] border bg-[var(--lum-card-bg)] border-[var(--lum-card-border)] hover:bg-[var(--lum-card-bg-hover)] hover:z-10 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-glass)]"
                                        >
                                            <span
                                                className="text-sm font-medium group-hover:underline"
                                                style={{color: foregroundColor}}
                                            >
                                                {item.name}
                                            </span>
                                            {item.description && (
                                                <span
                                                    className="text-xs leading-snug"
                                                    style={{color: colors.inactiveText}}
                                                >
                                                    {item.description}
                                                </span>
                                            )}
                                        </motion.a>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="outline" onPress={() => onOpenChange(false)}>
                            {t["Close"]}
                        </Button>
                    </Modal.Footer>
                </Modal.Dialog>
            </Modal.Container>
        </Modal.Backdrop>
    );
}
