import Markdown, { type Components } from 'react-markdown';

const components: Components = {
  // The default URL transform blanks unsafe hrefs (e.g. `javascript:`); show those as text.
  a: ({ href, children }) =>
    href === undefined || href === '' ? (
      <span className="md-unsafe-link">{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ),
  // Agent and repository text is untrusted: never load remote images from it.
  img: ({ alt }) => <span className="md-image-placeholder">[image: {alt ?? 'untitled'}]</span>,
};

/**
 * Markdown for untrusted text. Raw HTML is dropped (`skipHtml`) and
 * react-markdown's default URL transform strips `javascript:` and similar.
 */
export function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown skipHtml components={components}>
        {text}
      </Markdown>
    </div>
  );
}
