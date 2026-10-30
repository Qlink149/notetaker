import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/** Email, or role, so two people with the same name are not one row. */
function hint(p) {
  if (p.email) return p.email;
  if (p.role) return p.role;
  if (p.leftAt) return 'Left';
  if (p.anonymous) return 'Unassigned voice';
  return 'No email on file';
}

/**
 * Choose who a voice belongs to: search the saved people by name, email or role, or add a new person. It is drawn
 * by the app itself (not the browser's own select), so it looks the same on every device. Choosing a person asks
 * nothing more of its own; the caller shows what the change will do and asks before anything is written.
 */
export default function AssignPicker({ people, name, busy, error, onPick, onAddNew }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...people].sort(
      (a, b) =>
        Number(a.anonymous ?? false) - Number(b.anonymous ?? false) || a.name.localeCompare(b.name),
    );
    if (!q) return list;
    return list.filter((p) =>
      [p.name, p.email, p.role].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
  }, [people, query]);

  if (adding)
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAddNew(newName);
        }}
      >
        <p className="text-xs text-muted-foreground">Name for {name}</p>
        <Input
          autoFocus
          value={newName}
          aria-label={`New name for ${name}`}
          placeholder="New person"
          onChange={(e) => setNewName(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" className="rounded-full" disabled={busy}>
            Add person
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setAdding(false)}
          >
            Back
          </Button>
        </div>
      </form>
    );

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          className="pl-8"
          value={query}
          aria-label={`Search people to assign ${name} to`}
          placeholder="Search a person…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              onPick(shown[0]);
            }
          }}
        />
      </div>
      <div role="listbox" aria-label="People" className="max-h-56 overflow-y-auto -mx-1">
        {shown.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            No one matches “{query.trim()}”.
          </p>
        )}
        {shown.map((p) => (
          <button
            key={p.id}
            type="button"
            role="option"
            aria-selected="false"
            disabled={busy}
            onClick={() => onPick(p)}
            className="w-full text-left rounded-md px-2 py-1.5 hover:bg-secondary focus:bg-secondary outline-none disabled:opacity-50"
          >
            <span className="block text-sm font-medium">{p.name}</span>
            <span className="block text-xs text-muted-foreground">{hint(p)}</span>
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setNewName(query.trim());
          setAdding(true);
        }}
        className="w-full flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-sm hover:bg-secondary disabled:opacity-50"
      >
        <Plus className="w-4 h-4" /> Add new
      </button>
    </div>
  );
}
