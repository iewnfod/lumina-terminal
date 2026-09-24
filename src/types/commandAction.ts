import type {ReactNode} from "react";

/**
 * One entry in the command palette (Ctrl+Shift+P). Lives in types/ — not in
 * components/CommandPalette.tsx — so hooks/useCommandPaletteActions.ts can
 * build the list without importing from the components layer (§3.1 layering:
 * hooks never import components/).
 */
export interface CommandAction {
    id: string;
    label: string;
    description?: string;
    icon: ReactNode;
    shortcut?: { abbr?: string; content: string }[];
    category?: string;
    keywords?: string[];
    onSelect: () => void;
}
