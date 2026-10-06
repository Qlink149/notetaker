import { useState } from "react";
import { Copy, Download, Printer, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

function fmtTime(s) {
  if (s == null) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return ""; }
}

// Build plain-text export: title, date, summary, action items, transcript.
function buildText(meeting) {
  const lines = [];
  lines.push(`Meeting: ${meeting.title}`);
  lines.push(`Date: ${fmtDate(meeting.date || meeting.created_date)}`);
  if (meeting.duration_seconds > 0)
    lines.push(`Duration: ${Math.round(meeting.duration_seconds / 60)} min`);
  lines.push("");

  if (meeting.summary) {
    lines.push("SUMMARY");
    lines.push("========");
    lines.push(meeting.summary);
    lines.push("");
  }

  if (meeting.action_items && meeting.action_items.length) {
    lines.push("ACTION ITEMS");
    lines.push("============");
    meeting.action_items.forEach((a) => {
      const sp = a.speaker_name || "Unknown";
      lines.push(`- [${sp}] ${a.text}`);
    });
    lines.push("");
  }

  if (meeting.transcript && meeting.transcript.length) {
    lines.push("TRANSCRIPT");
    lines.push("==========");
    meeting.transcript.forEach((t) => {
      lines.push(`[${fmtTime(t.start_time)}] ${t.speaker_name}: ${t.text}`);
    });
  }

  return lines.join("\n");
}

// Build an HTML document for printing — uses the browser's native font
// rendering, so Gujarati and Devanagari scripts print correctly without
// embedding fonts. Opens in a new window and triggers print → Save as PDF.
function buildPrintHtml(meeting) {
  const escape = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [];

  parts.push(`<h1>${escape(meeting.title)}</h1>`);
  parts.push(`<p class="meta">${escape(fmtDate(meeting.date || meeting.created_date))}`);
  if (meeting.duration_seconds > 0)
    parts.push(` · ${Math.round(meeting.duration_seconds / 60)} min`);
  parts.push("</p>");

  if (meeting.summary) {
    // Summary is Markdown — convert basic syntax for print
    let html = escape(meeting.summary)
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^\- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
    parts.push(`<div class="section"><h2>Summary</h2><div class="summary">${html}</div></div>`);
  }

  if (meeting.action_items && meeting.action_items.length) {
    parts.push('<div class="section"><h2>Action Items</h2><ul class="actions">');
    meeting.action_items.forEach((a) => {
      parts.push(`<li><span class="speaker">${escape(a.speaker_name || "Unknown")}</span>: ${escape(a.text)}</li>`);
    });
    parts.push('</ul></div>');
  }

  if (meeting.transcript && meeting.transcript.length) {
    parts.push('<div class="section"><h2>Transcript</h2>');
    meeting.transcript.forEach((t) => {
      parts.push(
        `<div class="line">` +
        `<span class="ts">${fmtTime(t.start_time)}</span> ` +
        `<span class="sp">${escape(t.speaker_name)}</span>: ` +
        `<span class="tx">${escape(t.text)}</span>` +
        `</div>`
      );
    });
    parts.push('</div>');
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escape(meeting.title)} — Export</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Noto Sans Gujarati", "Noto Sans Devanagari", sans-serif; max-width: 780px; margin: 24px auto; padding: 0 24px; color: #111; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 4px; }
  .meta { color: #666; font-size: 13px; margin: 0 0 16px; }
  .section { margin-bottom: 20px; page-break-inside: avoid; }
  .summary h2, .summary h3 { color: #111; }
  .summary ul { margin: 4px 0; padding-left: 20px; }
  .summary li { margin: 2px 0; }
  .actions { padding-left: 20px; }
  .actions .speaker { font-weight: 600; }
  .line { margin: 3px 0; font-size: 13px; page-break-inside: avoid; }
  .ts { color: #999; font-size: 11px; font-family: monospace; }
  .sp { font-weight: 600; }
  @media print { body { margin: 0; padding: 12px; } }
</style></head><body>${parts.join("\n")}
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`;
}

export default function MeetingExport({ meeting }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildText(meeting));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { alert("Could not copy. Try the Download button."); }
  };

  const downloadTxt = () => {
    const blob = new Blob([buildText(meeting)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meeting.title.replace(/[^a-z0-9]+/gi, "_")}_transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPdf = () => {
    const w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups to export as PDF."); return; }
    w.document.write(buildPrintHtml(meeting));
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