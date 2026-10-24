import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Printer, Check, FileText, Loader2, Share2 } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { fmtDuration, fmtTime, lineText } from '@/lib/format';

const EXPORT_SCRIPTS = [
  { mode: 'roman', label: 'Roman' },
  { mode: 'native', label: 'Native' },
  { mode: 'both', label: 'Both' },
];

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '';
  }
}

// "both" exports roman with the native line underneath.
function transcriptLines(lines, scriptMode) {
  return lines.map((l) => {
    const head = `[${fmtTime(l.start)}] ${l.speakerName}: `;
    if (scriptMode === 'both' && l.textNative && l.textNative !== l.textRoman) {
      return `${head}${l.textRoman}\n${' '.repeat(head.length)}${l.textNative}`;
    }
    return head + lineText(l, scriptMode === 'native' ? 'native' : 'roman');
  });
}

function buildText(meeting, lines, scriptMode, parts) {
  const out = [`Meeting: ${meeting.title}`, `Date: ${fmtDate(meeting.date)}`];
  if (meeting.durationSec) out.push(`Duration: ${fmtDuration(meeting.durationSec)}`);
  out.push('');
  if (parts.notes && meeting.summary) out.push('SUMMARY', '=======', meeting.summary, '');
  if (parts.notes && meeting.actionItems?.length) {
    out.push('ACTION ITEMS', '============');
    meeting.actionItems.forEach((a) => out.push(`- [${a.speakerName}] ${a.text}`));
    out.push('');
  }
  if (parts.transcript && lines.length)
    out.push('TRANSCRIPT', '==========', ...transcriptLines(lines, scriptMode));
  return out.join('\n');
}

// PDF is the browser's print-to-PDF (system fonts for Gujarati and Devanagari): no browser engine is bundled
// on the server. The Word export embeds the fonts.
function buildPrintHtml(meeting, lines, scriptMode, parts) {
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = [`<h1>${esc(meeting.title)}</h1>`, `<p class="meta">${esc(fmtDate(meeting.date))}`];
  if (meeting.durationSec) html.push(` · ${fmtDuration(meeting.durationSec)}`);
  html.push('</p>');
  if (parts.notes && meeting.summary) {
    const summaryHtml = esc(meeting.summary)
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
    html.push(
      `<div class="section"><h2>Summary</h2><div class="summary">${summaryHtml}</div></div>`,
    );
  }
  if (parts.notes && meeting.actionItems?.length) {
    html.push('<div class="section"><h2>Action Items</h2><ul class="actions">');
    meeting.actionItems.forEach((a) =>
      html.push(`<li><span class="speaker">${esc(a.speakerName)}</span>: ${esc(a.text)}</li>`),
    );
    html.push('</ul></div>');
  }
  if (parts.transcript && lines.length) {
    html.push('<div class="section"><h2>Transcript</h2>');
    lines.forEach((l) => {
      const both = scriptMode === 'both' && l.textNative && l.textNative !== l.textRoman;
      const text = both
        ? `${esc(l.textRoman)}<br><span class="native">${esc(l.textNative)}</span>`
        : esc(lineText(l, scriptMode === 'native' ? 'native' : 'roman'));
      html.push(
        `<div class="line"><span class="ts">${fmtTime(l.start)}</span> <span class="sp">${esc(l.speakerName)}</span>: ${text}</div>`,
      );
    });
    html.push('</div>');
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
</style></head><body>${html.join('\n')}
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`;
}

export default function MeetingExport({ meeting, lines, scriptMode = 'roman' }) {
  const [copied, setCopied] = useState(false);
  const [wordBusy, setWordBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [notes, setNotes] = useState(true);
  const [transcript, setTranscript] = useState(true);
  // Follows the transcript switch until the person picks a script here.
  const [exportScript, setExportScript] = useState(scriptMode);
  const scriptTouched = useRef(false);
  const parts = { notes, transcript };
  useEffect(() => {
    if (!scriptTouched.current) setExportScript(scriptMode);
  }, [scriptMode]);
  // Share is for phones (WhatsApp, Drive). On a computer Chrome refuses Word files in its share menu
  // ("Permission denied") and the Word/PDF buttons beside it do the job, so it is not offered there.
  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    (typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: coarse)').matches);

  // The share menu (Drive, WhatsApp, Mail…) with the Word file. Browsers open it only straight from a
  // click, so the file is fetched beforehand (when the pointer reaches the button); a click before it is ready
  // makes the button "Tap to share" for a second click instead of failing.
  const [shareFile, setShareFile] = useState(null);
  // clicked before the file was ready: the next click shares
  const [askAgain, setAskAgain] = useState(false);
  // the browser refused the Word file: the next click shares the text instead
  const [textOnly, setTextOnly] = useState(false);
  const preparing = useRef(null);
  // bumped whenever the file would differ, so a fetch already in flight cannot replace the new one
  const shareGen = useRef(0);
  const prepareShare = () => {
    if (preparing.current) return preparing.current;
    const gen = shareGen.current;
    preparing.current = api.meetings
      .exportDocx(meeting.id, exportScript, parts)
      .then((blob) => {
        if (shareGen.current !== gen) return null;
        const file = new File([blob], `${meeting.title.replace(/[^a-z0-9]+/gi, '_')}.docx`, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        setShareFile(file);
        return file;
      })
      .catch((e) => {
        if (shareGen.current === gen) preparing.current = null;
        throw e;
      });
    return preparing.current;
  };
  // a different script or a different tick means a different Word file
  useEffect(() => {
    shareGen.current += 1;
    preparing.current = null;
    setShareFile(null);
    setAskAgain(false);
  }, [exportScript, meeting.id, notes, transcript]);

  const share = () => {
    const text = { title: meeting.title, text: buildText(meeting, lines, exportScript, parts) };
    const done = (p, withFile) =>
      p.catch((e) => {
        if (e?.name === 'AbortError') return; // the person closed the share menu
        if (withFile && e?.name === 'NotAllowedError') {
          // this browser will not share a Word file: offer the text (a new click is needed to open the menu)
          setTextOnly(true);
          return;
        }
        alert(e?.message || 'Could not share.');
      });
    if (textOnly) {
      done(navigator.share(text), false);
      return;
    }
    if (shareFile) {
      setAskAgain(false);
      const withFile = Boolean(navigator.canShare?.({ files: [shareFile] }));
      // nothing awaited before this call: it still counts as the click
      done(
        navigator.share(withFile ? { files: [shareFile], title: meeting.title } : text),
        withFile,
      );
      return;
    }
    // this browser cannot share files at all: share the text now, while the click counts
    if (
      typeof navigator.canShare === 'function' &&
      !navigator.canShare({
        files: [
          new File([''], 'x.docx', {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
        ],
      })
    ) {
      done(navigator.share(text), false);
      return;
    }
    setShareBusy(true);
    prepareShare()
      .then((file) => {
        if (file) setAskAgain(true);
      })
      .catch((e) => alert(e?.message || 'Could not create the Word file.'))
      .finally(() => setShareBusy(false));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildText(meeting, lines, exportScript, parts));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('Could not copy. Try the Download button.');
    }
  };

  const downloadTxt = () => {
    const blob = new Blob([buildText(meeting, lines, exportScript, parts)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meeting.title.replace(/[^a-z0-9]+/gi, '_')}_transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadWord = async () => {
    setWordBusy(true);
    try {
      const blob = await api.meetings.exportDocx(meeting.id, exportScript, parts);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${meeting.title.replace(/[^a-z0-9]+/gi, '_')}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e?.message || 'Could not create the Word file.');
    } finally {
      setWordBusy(false);
    }
  };

  const printPdf = () => {
    const w = window.open('', '_blank');
    if (!w) return alert('Please allow pop-ups to export as PDF.');
    w.document.write(buildPrintHtml(meeting, lines, exportScript, parts));
    w.document.close();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-xs">
        <div className="inline-flex items-center gap-1.5">
          <Checkbox
            id="export-notes"
            checked={notes}
            disabled={!transcript}
            onCheckedChange={(v) => setNotes(v === true)}
          />
          <label htmlFor="export-notes" className="leading-tight">
            <span className="font-medium">Notes</span>
            <span className="text-muted-foreground">
              {' '}
              — summary, overview, decisions, action items
            </span>
          </label>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <Checkbox
            id="export-transcript"
            checked={transcript}
            disabled={!notes}
            onCheckedChange={(v) => setTranscript(v === true)}
          />
          <label htmlFor="export-transcript" className="font-medium">
            Transcript
          </label>
        </div>
        <div
          className="flex gap-1 bg-secondary rounded-full p-0.5"
          role="radiogroup"
          aria-label="In the file"
        >
          {EXPORT_SCRIPTS.map((s) => (
            <button
              key={s.mode}
              type="button"
              role="radio"
              aria-checked={exportScript === s.mode}
              onClick={() => {
                scriptTouched.current = true;
                setExportScript(s.mode);
              }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                exportScript === s.mode
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        {canShare && (
          <Button
            variant={askAgain || textOnly ? 'default' : 'outline'}
            size="sm"
            onClick={share}
            onPointerEnter={() => prepareShare().catch(() => {})}
            onFocus={() => prepareShare().catch(() => {})}
            disabled={shareBusy}
          >
            {shareBusy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Share2 className="w-4 h-4 mr-1" />
            )}{' '}
            {shareBusy
              ? 'Preparing…'
              : textOnly
                ? 'Share as text'
                : askAgain
                  ? 'Tap to share'
                  : 'Share…'}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" size="sm" onClick={downloadTxt}>
          <Download className="w-4 h-4 mr-1" /> .txt
        </Button>
        <Button variant="outline" size="sm" onClick={downloadWord} disabled={wordBusy}>
          {wordBusy ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <FileText className="w-4 h-4 mr-1" />
          )}{' '}
          Word
        </Button>
        <Button variant="outline" size="sm" onClick={printPdf}>
          <Printer className="w-4 h-4 mr-1" /> PDF
        </Button>
      </div>
    </div>
  );
}
