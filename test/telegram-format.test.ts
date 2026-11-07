import { expect, test } from "bun:test";
import { fit, md, textLength } from "../src/telegram-format.ts";

test("Markdown becomes the tags Telegram renders", () => {
  expect(md("## Plan\n\nRun **`gh pr list`** for *each* repo, see [docs](https://cli.github.com).")).toBe(
    '<b>Plan</b>\n\nRun <b><code>gh pr list</code></b> for <i>each</i> repo, see <a href="https://cli.github.com">docs</a>.',
  );
});

test("lists become bullets and numbers; code blocks become pre", () => {
  expect(md("1. Find PRs\n2. Review\n   - read the diff\n\n```sh\ngit fetch\n```")).toBe("1. Find PRs\n2. Review\n   • read the diff\n\n<pre>git fetch</pre>");
});

test("text that looks like HTML is escaped, entities are not doubled", () => {
  expect(md("Use <number> & `a < b`, not &amp;")).toBe("Use &lt;number&gt; &amp; <code>a &lt; b</code>, not &amp;");
});

test("inside a quote, code blocks and nested quotes flatten", () => {
  expect(md("> quoted\n\n```\nx\n```", { quoted: true })).toBe("quoted\n\n<code>x</code>");
});

test("only http links become links", () => {
  expect(md("[x](javascript:alert(1))")).toBe("x");
});

test("fit cuts the Markdown until the rendered text fits", () => {
  const html = fit("word ".repeat(2000), (s) => `<b>Ready</b>\n${md(s)}`);
  expect(textLength(html)).toBeLessThanOrEqual(4000);
  expect(html).toEndWith("…");
});
