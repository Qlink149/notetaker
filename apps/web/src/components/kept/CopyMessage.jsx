import { Copy } from 'lucide-react';
import { useKept } from '@/lib/keptStore';

/** Copies a WhatsApp message and confirms with the Kept toast. Sits beside the button that opens WhatsApp. */
export default function CopyMessage({ text, className = 'k-icon' }) {
  const { toast } = useKept();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy.');
    }
  };
  return (
    <button type="button" className={className} aria-label="Copy message" onClick={copy}>
      <Copy className="w-[18px] h-[18px]" strokeWidth={2} />
    </button>
  );
}
