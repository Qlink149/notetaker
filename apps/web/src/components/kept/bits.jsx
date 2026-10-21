import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { hueOf, initialsOf, skyArt } from '@/lib/kept';

/** The prototype's sky with mountains, for heroes and cards. */
export function SkyArt({ phase, fade, seed, sunX, sunY, className = 'k-art' }) {
  const html = useMemo(
    () => skyArt({ phase, fade, seed, sunX, sunY }),
    [phase, fade, seed, sunX, sunY],
  );
  return (
    <div className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** A person's initials on their colour. `size`: "mini" (20 px) or "av" (40 px). */
export function Avatar({ id, name, size = 'mini', className = '' }) {
  return (
    <span
      className={`${size === 'av' ? 'k-av' : 'k-mini'} ${className}`}
      style={{ background: hueOf(id) }}
      title={name}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

/** A bottom sheet: closes on the backdrop, the close button or Escape. */
export function Sheet({ title, head, onClose, children, label }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="k-sheetbg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="k-sheet" role="dialog" aria-modal="true" aria-label={label ?? title}>
        <div className="k-grab" />
        <div className="k-sheethead">
          {title ? <h3>{title}</h3> : head}
          <button type="button" className="k-round" onClick={onClose} aria-label="Close">
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** WhatsApp's mark (no icon library has it). */
export function WhatsAppIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.2a9.7 9.7 0 0 0-8.4 14.6L2.3 21.7l5-1.3A9.7 9.7 0 1 0 12 2.2Zm0 17.7c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.3-.4.7-1.2.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.9 2c0 1.2.9 2.4 1 2.5.1.2 1.7 2.7 4.2 3.8 1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.2.2-.6.2-1 .1-1.2l-.5-.5Z" />
    </svg>
  );
}
