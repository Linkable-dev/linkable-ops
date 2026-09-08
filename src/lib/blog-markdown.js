// Converts between the article block format stored in blog_posts.blocks and a
// small markdown dialect the editor textarea uses:
//   ## Heading (h2)   ### Heading (h3)   > quote   - item / 1. item   blank line between paragraphs
// Inline **bold**, *italic* and [text](url) pass through untouched.

export function blocksToMarkdown(blocks = []) {
  return blocks.map((b) => {
    switch (b.type) {
      case "h2": return `## ${b.text || ""}`;
      case "h3": return `### ${b.text || ""}`;
      case "quote": return `> ${b.text || ""}`;
      case "ul": return (b.items || []).map((i) => `- ${i}`).join("\n");
      case "ol": return (b.items || []).map((i, n) => `${n + 1}. ${i}`).join("\n");
      default: return b.text || "";
    }
  }).join("\n\n");
}

export function markdownToBlocks(md = "") {
  const blocks = [];
  const chunks = md.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-*] /.test(l))) { blocks.push({ type: "ul", text: null, items: lines.map((l) => l.replace(/^[-*] /, "")) }); continue; }
    if (lines.every((l) => /^\d+[.)] /.test(l))) { blocks.push({ type: "ol", text: null, items: lines.map((l) => l.replace(/^\d+[.)] /, "")) }); continue; }
    const text = lines.join(" ");
    if (/^### /.test(text)) blocks.push({ type: "h3", text: text.replace(/^### /, ""), items: null });
    else if (/^## /.test(text)) blocks.push({ type: "h2", text: text.replace(/^## /, ""), items: null });
    else if (/^# /.test(text)) blocks.push({ type: "h2", text: text.replace(/^# /, ""), items: null });
    else if (/^> /.test(text)) blocks.push({ type: "quote", text: lines.map((l) => l.replace(/^> ?/, "")).join(" "), items: null });
    else blocks.push({ type: "p", text, items: null });
  }
  return blocks;
}

export function countWords(blocks = []) {
  return blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0) + (b.items ? b.items.join(" ").split(/\s+/).length : 0), 0);
}

// Minimal preview renderer (escapes HTML, then applies inline marks).
export function inlineHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}
