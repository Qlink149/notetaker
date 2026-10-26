import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

function fold(name) {
  return (name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s.\-_,]+/g, '');
}

/** Search match: a prefix, or the saved name sitting inside a longer typed name ("parag" in "parag bhai"). */
function matches(query, name) {
  const q = fold(query);
  const n = fold(name);
  if (!q) return true;
  if (!n) return false;
  if (n.includes(q) && q.length >= 2) return true;
  return q.includes(n) && n.length >= 4 && q !== n;
}

/**
 * Search this meeting's speakers and saved people, or type a name that is not in the list.
 * `onCommit` may resolve `{ similar }` when a new name looks like someone already saved.
 */
export default function PersonPicker({
  value,
  onChange,
  onCommit,
  onSubmit,
  people = [],
  speakers = [],
  excludeName = '',
  includeMeetingSpeakers = true,
  placeholder = 'Search saved people, or type a new name',
  ariaLabel,
  inputClassName = 'h-8 text-xs',
  disabled = false,
  startOpen = false,
  onDone,
}) {
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState(null);
  const [pendingName, setPendingName] = useState('');
  const query = value.trim();

  const speakerOptions = includeMeetingSpeakers
    ? speakers.filter((s) => s.displayName !== excludeName && matches(query, s.displayName))
    : [];
  const represented = new Set(speakers.map((s) => s.personId).filter(Boolean));
  const personOptions = people.filter((p) => {
    if (represented.has(p.id)) return false;
    if (excludeName && fold(p.name) === fold(excludeName)) return false;
    if (p.anonymous && !query) return false;
    return matches(query, p.name);
  });
  const exactTaken =
    personOptions.some((p) => fold(p.name) === fold(query)) ||
    speakerOptions.some((s) => fold(s.displayName) === fold(query)) ||
    people.some((p) => fold(p.name) === fold(query));
  const showCreate = Boolean(query) && !exactTaken;

  const commit = async (choice) => {
    setBusy(true);
    setError('');
    try {
      const result = await onCommit(choice);
      if (result?.similar?.length) {
        setPendingName(choice.name);
        setSimilar(result.similar);
        setOpen(true);
        return;
      }
      setSimilar(null);
      setOpen(false);
      onDone?.();
    } catch (e) {
      setError(e?.message || 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  // Enter takes a real match before it creates anyone, so "Parag Bhai" lands on Parag.
  const preferred = () => {
    const exactPerson = personOptions.find((p) => fold(p.name) === fold(query));
    if (exactPerson) return { type: 'person', personId: exactPerson.id, name: exactPerson.name };
    const exactSpeaker = speakerOptions.find((s) => fold(s.displayName) === fold(query));
    if (exactSpeaker)
      return { type: 'speaker', diar: exactSpeaker.diar, name: exactSpeaker.displayName };
    const contained = personOptions.find((p) => {
      const n = fold(p.name);
      return n.length >= 4 && fold(query).includes(n) && n !== fold(query);
    });
    if (contained) return { type: 'person', personId: contained.id, name: contained.name };
    return null;
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      setSimilar(null);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const choice = preferred();
    if (choice) {
      commit(choice);
      return;
    }
    if (onSubmit) {
      onSubmit();
      return;
    }
    if (speakerOptions.length || personOptions.length) return;
    if (query) commit({ type: 'new', name: query });
  };

  return (
    <div className="min-w-0 flex-1">
      <Input
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled || busy}
        placeholder={placeholder}
        className={inputClassName}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setSimilar(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && !similar && (
        <ul
          role="listbox"
          className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card text-xs shadow-sm"
        >
          {speakerOptions.length > 0 && (
            <li className="px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              In this meeting
            </li>
          )}
          {speakerOptions.map((s) => (
            <li key={s.diar}>
              <button
                type="button"
                role="option"
                className="block w-full px-2 py-1.5 text-left hover:bg-secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit({ type: 'speaker', diar: s.diar, name: s.displayName })}
              >
                {s.displayName}
              </button>
            </li>
          ))}
          {personOptions.length > 0 && (
            <li className="px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Saved people
            </li>
          )}
          {personOptions.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                className="block w-full px-2 py-1.5 text-left hover:bg-secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit({ type: 'person', personId: p.id, name: p.name })}
              >
                {p.name}
              </button>
            </li>
          ))}
          {showCreate && (
            <li>
              <button
                type="button"
                role="option"
                className="block w-full px-2 py-1.5 text-left hover:bg-secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit({ type: 'new', name: query })}
              >
                Create “{query}”
              </button>
            </li>
          )}
          {!speakerOptions.length && !personOptions.length && !showCreate && (
            <li className="px-2 py-1.5 text-muted-foreground">No matching person</li>
          )}
        </ul>
      )}
      {similar && (
        <div className="mt-1 rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs space-y-2">
          <p className="text-amber-900">
            “{pendingName}” looks like someone you already have. Is it the same person?
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {similar.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => commit({ type: 'person', personId: o.id, name: o.name })}
              >
                Yes, {o.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => commit({ type: 'new', name: pendingName, createNew: true })}
            >
              No, a different person
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
