import MarkdownIt from "markdown-it";

const options = { linkify: true, typographer: true, breaks: false } as const;
const escaping = new MarkdownIt({ ...options, html: false });
const passThrough = new MarkdownIt({ ...options, html: true });

export interface MarkdownToHtmlOptions {
  /**
   * Pass raw HTML in the Markdown through to the output. Off by default: raw HTML is escaped,
   * so `<script>` or `<img onerror>` in an uploaded file cannot run when the output is shown.
   * Turn it on only for trusted input, or sanitise the output before rendering it.
   */
  html?: boolean;
}

/**
 * Provides the reverse of `htmlToMarkdown` for cases where extracted
 * markdown needs to be rendered back to HTML (e.g. previews, email
 * output). Bare URLs are auto-linked. Raw HTML is escaped unless
 * `options.html` is set.
 */
export function markdownToHtml(markdown: string, options: MarkdownToHtmlOptions = {}): string {
  if (!markdown || markdown.trim() === "") {
    return "";
  }
  return (options.html ? passThrough : escaping).render(markdown);
}
