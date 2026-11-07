import { Lexer, type Token } from "marked";

/**
 * Markdown (briefs, summaries, questions) → the HTML subset Telegram renders
 * with parse_mode "HTML": b, i, s, code, pre, a, blockquote. Anything else
 * becomes plain text, so the result always parses.
 */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((t) => {
    switch (t.type) {
      case "strong":
        return `<b>${inline(t.tokens)}</b>`;
      case "em":
        return `<i>${inline(t.tokens)}</i>`;
      case "del":
        return `<s>${inline(t.tokens)}</s>`;
      case "codespan":
        return `<code>${esc(unescape(t.text))}</code>`;
      case "link":
        return /^https?:\/\//.test(t.href) ? `<a href="${esc(t.href).replace(/"/g, "&quot;")}">${inline(t.tokens)}</a>` : inline(t.tokens);
      case "br":
        return "\n";
      case "text":
        return t.tokens ? inline(t.tokens) : esc(unescape(t.text));
      default:
        return esc(unescape("text" in t ? String(t.text) : t.raw));
    }
  }).join("");
}

/** Inside a quote Telegram allows no pre and no nested quote, so those flatten. */
function block(tokens: Token[], depth = 0, quoted = false): string {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading":
        out.push(`<b>${inline(t.tokens)}</b>`);
        break;
      case "paragraph":
        out.push(inline(t.tokens));
        break;
      case "text":
        out.push(t.tokens ? inline(t.tokens) : esc(t.text));
        break;
      case "code":
        out.push(quoted ? `<code>${esc(t.text)}</code>` : `<pre>${esc(t.text)}</pre>`);
        break;
      case "blockquote":
        out.push(quoted ? block(t.tokens ?? [], depth, true) : `<blockquote>${block(t.tokens ?? [])}</blockquote>`);
        break;
      case "list": {
        const start = typeof t.start === "number" ? t.start : 1;
        const pad = "   ".repeat(depth);
        out.push(
          t.items
            .map((item: any, i: number) => `${pad}${t.ordered ? `${start + i}.` : "•"} ${block(item.tokens, depth + 1, quoted).replace(/^\s+/, "")}`)
            .join("\n"),
        );
        break;
      }
      case "hr":
        out.push("──────");
        break;
      case "space":
        break;
      default:
        out.push(quoted ? esc(t.raw.trim()) : `<pre>${esc(t.raw.trim())}</pre>`);
    }
  }
  return out.filter(Boolean).join(depth ? "\n" : "\n\n");
}

/** marked keeps HTML entities in text; Telegram wants them once, escaped by us. */
function unescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function md(markdown: string, opts: { quoted?: boolean } = {}): string {
  return block(new Lexer({ gfm: true }).lex(markdown.trim()), 0, opts.quoted);
}

/** Plain text from our HTML, for when Telegram refuses the markup. */
export function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Markdown cut to fit Telegram's 4096 characters once rendered by `build`. */
export function fit(source: string, build: (md: string) => string, limit = 4000): string {
  for (const max of [3000, 1500, 600]) {
    const cut = source.length > max ? `${source.slice(0, max).trimEnd()}…` : source;
    const html = build(cut);
    if (textLength(html) <= limit) return html;
  }
  return build("(too long for Telegram: open the card on the board)");
}

/** Telegram drops HTML tags from its 4096 limit; plain text is what is counted. */
export function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "_").length;
}
