import { useMemo, useState } from 'react';
import { Calendar, Loader2, Search } from 'lucide-react';
import { useKept } from '@/lib/keptStore';
import { Avatar, Sheet } from '@/components/kept/bits';
import { PRIORITY_LABEL, addDays, firstName, nextWeekday, niceDay, today } from '@/lib/kept';

/** Chips for the people most likely meant, and a search over everyone. */
function PeoplePicker({ label, value, onChange, exclude, people, me, suggested = [], optional }) {
  const [q, setQ] = useState('');
  const byId = new Map(people.map((p) => [p.id, p]));
  const chips = [
    ...new Set([me, value, ...suggested].filter((id) => id && byId.has(id) && id !== exclude)),
  ];
  const matches = q.trim()
    ? people
        .filter((p) => p.id !== exclude && p.name.toLowerCase().includes(q.trim().toLowerCase()))
        .slice(0, 6)
    : [];
  return (
    <div>
      <div className="k-lbl">
        {label}
        {optional && <span style={{ color: 'var(--k-faint)', fontWeight: 500 }}>{optional}</span>}
      </div>
      {chips.length > 0 && (
        <div className="k-hscroll" role="group" aria-label={label}>
          {chips.map((id) => (
            <button
              key={id}
              type="button"
              className="k-pchip"
              aria-pressed={value === id}
              onClick={() => onChange(value === id && optional ? null : id)}
            >
              <Avatar id={id} name={byId.get(id).name} />
              {id === me ? 'Me' : firstName(byId.get(id).name)}
            </button>
          ))}
        </div>
      )}
      <div className="relative mt-2.5">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[var(--k-faint)]" />
        <input
          className="k-inp"
          style={{ paddingLeft: 44 }}
          placeholder="Search people"
          aria-label={`${label}: search people`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {matches.length > 0 && (
        <div className="k-list mt-2">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="k-srch"
              onClick={() => {
                onChange(p.id);
                setQ('');
              }}
            >
              <Avatar id={p.id} name={p.name} size="av" />
              <span className="self-center">
                <b>
                  {p.name}
                  {p.id === me ? ' (you)' : ''}
                </b>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * New task, edit a task, or approve a suggested one after changing it. `initial`: { editId?, title, ownerId,
 * buddyId, priority, due, meetingId, fromSuggestion?: { meetingId, index }, speakerName? }.
 */
export default function TaskForm({ initial, onDone }) {
  const { people, me, tasks, createTask, updateTask, closeSheet, toast } = useKept();
  const [f, setF] = useState({ priority: 'med', due: today(), ...initial });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  // people who already have tasks come first in the chips
  const frequent = useMemo(() => {
    const n = new Map();
    for (const t of tasks ?? []) if (t.ownerId) n.set(t.ownerId, (n.get(t.ownerId) ?? 0) + 1);
    return [...n]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, 8);
  }, [tasks]);

  const quick = [
    ['Today', today()],
    ['Tomorrow', addDays(1)],
    ['Friday', nextWeekday(5)],
    ['Next week', addDays(7)],
  ];
  const custom = f.due && !quick.some(([, d]) => d === f.due);

  const save = async () => {
    if (!f.ownerId) return toast('Choose who’s doing it.');
    if (!f.title?.trim()) return toast('Describe the task.');
    setBusy(true);
    try {
      const body = {
        title: f.title.trim(),
        ownerId: f.ownerId,
        buddyId: f.buddyId && f.buddyId !== f.ownerId ? f.buddyId : null,
        priority: f.priority,
        due: f.due || null,
      };
      if (f.editId) {
        await updateTask(f.editId, body);
        toast('Task updated.');
      } else {
        const t = await createTask({
          ...body,
          meetingId: f.meetingId ?? null,
          ...(f.fromSuggestion ? { fromSuggestion: f.fromSuggestion } : {}),
        });
        toast(t.ownerId === me ? 'Added to your list.' : `Added for ${firstName(t.ownerName)}.`);
      }
      onDone?.();
      closeSheet();
    } catch (e) {
      toast(e?.message || 'Could not save the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={f.editId ? 'Edit task' : f.fromSuggestion ? 'Approve task' : 'New task'}
      onClose={closeSheet}
    >
      <div className="px-[18px] pb-6">
        {f.fromSuggestion && f.speakerName && !f.ownerId && (
          <p className="text-xs text-[var(--k-sub)] mt-2">
            The summary gave this to “{f.speakerName}”. Pick who that is.
          </p>
        )}
        <PeoplePicker
          label="Who’s doing it?"
          value={f.ownerId}
          onChange={(id) => set({ ownerId: id, buddyId: f.buddyId === id ? null : f.buddyId })}
          people={people}
          me={me}
          suggested={frequent}
        />
        <div className="k-lbl">What needs to be done?</div>
        <textarea
          className="k-inp"
          aria-label="What needs to be done?"
          placeholder="e.g. Share store-wise sales for October"
          value={f.title ?? ''}
          onChange={(e) => set({ title: e.target.value })}
        />
        <div className="k-lbl">Priority</div>
        <div className="k-seg3" role="group" aria-label="Priority">
          {['low', 'med', 'high'].map((p) => (
            <button
              key={p}
              type="button"
              className={`p-${p}`}
              aria-pressed={f.priority === p}
              onClick={() => set({ priority: p })}
            >
              <span className="k-dot" />
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
        <PeoplePicker
          label="Task buddy"
          optional="optional · shared task"
          value={f.buddyId ?? null}
          onChange={(id) => set({ buddyId: id })}
          exclude={f.ownerId}
          people={people}
          me={me}
          suggested={frequent}
        />
        <div className="k-lbl">Deadline</div>
        <div className="k-dchips" role="group" aria-label="Deadline">
          {quick.map(([label, d]) => (
            <button
              key={label}
              type="button"
              aria-pressed={f.due === d}
              onClick={() => set({ due: d })}
            >
              {label}
            </button>
          ))}
          <label className={custom ? 'k-on' : ''}>
            <Calendar className="w-[15px] h-[15px]" /> {custom ? niceDay(f.due) : 'Pick date'}
            <input
              type="date"
              aria-label="Pick a date"
              value={f.due ?? ''}
              onChange={(e) => e.target.value && set({ due: e.target.value })}
            />
          </label>
          <button type="button" aria-pressed={!f.due} onClick={() => set({ due: null })}>
            No date
          </button>
        </div>
        {/* the save button stays in view while the form scrolls */}
        <div className="sticky -bottom-5 mt-[22px] -mx-[18px] px-[18px] pt-3 pb-5 bg-background/95 backdrop-blur">
          <button type="button" className="k-btn k-primary" disabled={busy} onClick={save}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {f.editId ? 'Save changes' : f.fromSuggestion ? 'Approve task' : 'Add task'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
