import { useState } from "react";
import { Copy, Download, Printer, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDuration, fmtTime, lineText } from "@/lib/format";

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

// "both" exports roman with the native line underneath.
function transcriptLines(lines, scriptMode) {
  return lines.map((l) => {
    const head = `[${fmtTime(l.start)}] ${l.speakerName}: `;
    if (scriptMode === "both" && l.textNative && l.textNative !== l.textRoman) {
      return `${head}${l.textRoman}\n${" ".repeat(head.length)}${l.textNative}`;
    }
    return head + lineText(l, scriptMode === "native" ? "native" : "roman");
  });
}

function buildText(meeting, lines, scriptMode) {
  const out = [`Meeting: ${meeting.title}`, `Date: ${fmtDate(meeting.date)}`];
  if (meeting.durationSec) out.push(`Duration: ${fmtDuration(meeting.durationSec)}`);
  out.push("");
  if (meeting.summary) out.push("SUMMARY", "=======", meeting.summary, "");
  if (meeting.actionItems?.length) {
    out.push("ACTION ITEMS", "============");
    meeting.actionItems.forEach((a) => out.push(`- [${a.speakerName}] ${a.text}`));
    out.push("");
  }
  if (lines.length) out.push("TRANSCRIPT", "==========", ...transcriptLines(lines, scriptMode));
  return out.join("\n");
}

// Print-to-PDF via the browser so Gujarati and Devanagari render with system fonts. Phase 4 replaces this.
function buildPrintHtml(meeting, lines, scriptMode) {
  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [`<h1>${esc(meeting.title)}</h1>`, `<p class="meta">${esc(fmtDate(meeting.date))}`];
  if (meeting.durationSec) parts.push(` · ${fmtDuration(meeting.durationSec)}`);
  parts.push("</p>");
  if (meeting.summary) {
    const html = esc(meeting.summary)
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")
      .replace(/^### (.+)$/gm, "<h4>$1</h4>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
    parts.push(`<div class="section"><h2>Summary</h2><div class="summary">${html}</div></div>`);
  }
  if (meeting.actionItems?.length) {
    parts.push('<div class="section"><h2>Action Items</h2><ul class="actions">');
    meeting.actionItems.forEach((a) => parts.push(`<li><span class="speaker">${esc(a.speakerName)}</span>: ${esc(a.text)}</li>`));
    parts.push("</ul></div>");
  }
  if (lines.length) {
    parts.push('<div class="section"><h2>Transcript</h2>');
    lines.forEach((l) => {
      const both = scriptMode === "both" && l.textNative && l.textNative !== l.textRoman;
      const text = both ? `${esc(l.textRoman)}<br><span class="native">${esc(l.textNative)}</span>` : esc(lineText(l, scriptMode === "native" ? "native" : "roman"));
      parts.push(`<div class="line"><span class="ts">${fmtTime(l.start)}</span> <span class="sp">${esc(l.speakerName)}</span>: ${text}</div>`);
    });
    parts.push("</div>");
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(meeting.title)} — Export</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Noto Sans Gujarati", "Noto Sans Devanagari", sans-serif; max-width: 780px; margin: 24px auto; padding: 0 24px; color: #111; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 4px; }
  .meta { color: #666; font-size: 13px; margin: 0 0 16px; }
  .section { margin-bottom: 20px; }
  .summary ul, .actions { margin: 4px 0; padding-left: 20px; }
  .actions .speaker, .sp { font-weight: 600; }
  .line { margin: 3px 0; font-size: 13px; page-break-inside: avoid; }
  .native { color: #555; }
  .ts { color: #999; font-size: 11px; font-family: monospace; }
  @media print { body { margin: 0; padding: 12px; } }
</style></head><body>${parts.join("\n")}
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`;
}

export default function MeetingExport({ meeting, lines, scriptMode = "roman" }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildText(meeting, lines, scriptMode));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert("Could not copy. Try the Download button.");
    }
  };

  const downloadTxt = () => {
    const blob = new Blob([buildText(meeting, lines, scriptMode)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meeting.title.replace(/[^a-z0-9]+/gi, "_")}_transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPdf = () => {
    const w = window.open("", "_blank");
    if (!w) return alert("Please allow pop-ups to export as PDF.");
    w.document.write(buildPrintHtml(meeting, lines, scriptMode));
    w.document.close();
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button variant="outline" size="sm" onClick={downloadTxt}>
        <Download className="w-4 h-4 mr-1" /> .txt
      </Button>
      <Button variant="outline" size="sm" onClick={printPdf}>
        <Printer className="w-4 h-4 mr-1" /> PDF
      </Button>
    </div>
  );
}
