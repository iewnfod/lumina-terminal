import type {CSSProperties, MouseEvent, ReactNode} from "react";
import {openExternal} from "../../lib/openerApi.ts";

interface ExternalLinkProps {
	href: string;
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
	title?: string;
}

/**
 * Anchor that opens an external URL in the system browser.
 *
 * A plain `<a target="_blank">` is dead in the Tauri webview (it can't spawn
 * browser windows), so this routes the click through the opener plugin via
 * `lib/openerApi.ts` — the one place that knows how external links open.
 * Keeps the real `href` so middle-click / copy-link / hover-preview still work
 * in browsers (and in tests run outside Tauri).
 */
export default function ExternalLink({href, children, className, style, title}: ExternalLinkProps) {
	const onClick = (e: MouseEvent) => {
		e.preventDefault();
		openExternal(href);
	};

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={className}
			style={style}
			title={title}
			onClick={onClick}
		>
			{children}
		</a>
	);
}
