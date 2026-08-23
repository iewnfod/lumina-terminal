import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import ExternalLink from "./ui/ExternalLink.tsx";

/**
 * Shared Markdown renderer for release notes / changelogs.
 *
 * Uses react-markdown (safe by default — no raw HTML) + remark-gfm for
 * GitHub-flavored markdown (tables, strikethrough, task lists, autolinks).
 * Styling is inline + Tailwind utilities so it inherits the surrounding
 * color and works in both the UpdateModal and the About page's modal without
 * depending on @tailwindcss/typography.
 */

interface MarkdownProps {
	children: string;
	className?: string;
}

// Element styling: compact, inherits color, no default margins that would
// fight the surrounding layout.
const components: Components = {
	h1: ({ children }) => (
		<h1 className="text-base font-bold mt-3 mb-1.5 first:mt-0">{children}</h1>
	),
	h2: ({ children }) => (
		<h2 className="text-base font-semibold mt-3 mb-1.5 first:mt-0">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="text-sm font-semibold mt-2.5 mb-1 first:mt-0">{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h4>
	),
	h5: ({ children }) => (
		<h5 className="text-sm font-medium mt-2 mb-1 first:mt-0">{children}</h5>
	),
	h6: ({ children }) => (
		<h6 className="text-xs font-medium mt-2 mb-1 first:mt-0">{children}</h6>
	),
	p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
	a: ({ children, href }) => (
		// ExternalLink routes the click through the opener plugin — a plain
		// target="_blank" anchor is dead inside the Tauri webview.
		<ExternalLink href={href ?? "#"} className="underline hover:opacity-80">
			{children}
		</ExternalLink>
	),
	ul: ({ children }) => (
		<ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>
	),
	li: ({ children }) => <li className="leading-relaxed">{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="border-l-2 pl-3 my-1.5 opacity-80 italic">
			{children}
		</blockquote>
	),
	code: ({ children }) => (
			<code className="px-1 py-0.5 rounded text-[0.85em] bg-default/20 font-mono">
				{children}
			</code>
		),
	pre: ({ children }) => (
			<pre className="my-2 p-2.5 rounded-md overflow-x-auto bg-default/20 text-[0.85em]">
				{children}
			</pre>
		),
	hr: () => <hr className="my-3 border-current opacity-20" />,
	table: ({ children }) => (
		<div className="overflow-x-auto my-2">
			<table className="border-collapse text-sm">{children}</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border border-current/30 px-2 py-1 font-semibold text-left">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="border border-current/30 px-2 py-1">{children}</td>
	),
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em>{children}</em>,
};

export default function Markdown({ children, className }: MarkdownProps) {
	return (
		<div className={`text-sm ${className ?? ""}`}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
}
