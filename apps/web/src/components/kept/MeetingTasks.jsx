import { useEffect } from 'react';
import { ChevronRight, Plus, Sparkles } from 'lucide-react';
import { useKeptOptional } from '@/lib/keptStore';
import TaskRow from '@/components/kept/TaskRow';
import { today } from '@/lib/kept';

/** This meeting's tasks, its suggested tasks (its action items) to review, and adding one by hand. */
export default function MeetingTasks({ meetingId, summaryKey }) {
  const kept = useKeptOptional();
  const refresh = kept?.refresh;
  // a summary written (or rewritten) while the page is open brings its action items as suggestions
  useEffect(() => {
    refresh?.();
  }, [refresh, summaryKey]);
  if (!kept) return null;
  const { tasks, suggestions, openReview, openForm } = kept;

  const mine = (tasks ?? []).filter((t) => t.meetingId === meetingId);
  const pending = suggestions.filter((s) => s.meetingId === meetingId);

  return (
    <div className="mb-6" data-testid="meeting-tasks">
      <div className="k-sech">
        <h2>Tasks</h2>
        <span className="k-n">{mine.length}</span>
        <button
          type="button"
          className="k-add"
          aria-label="Add a task for this meeting"
          onClick={() => openForm({ meetingId, due: today() })}
        >
          <Plus className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>
      </div>
      {pending.length > 0 && (
        <button type="button" className="k-suggest mb-3" onClick={() => openReview(meetingId)}>
          <span className="k-icon k-ac bg-white">
            <Sparkles className="w-[18px] h-[18px]" />
          </span>
          <span>
            <b>
              {pending.length} suggested task{pending.length === 1 ? '' : 's'}
            </b>
            <small>From this meeting’s action items · tap to review</small>
          </span>
          <ChevronRight className="w-[18px] h-[18px] ml-auto text-[var(--k-accent)]" />
        </button>
      )}
      <div className="k-list">
        {mine.length ? (
          mine.map((t) => <TaskRow key={t.id} task={t} />)
        ) : (
          <div className="k-empty">
            {pending.length
              ? 'Approve the suggested tasks to track them here.'
              : 'No tasks from this meeting yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
