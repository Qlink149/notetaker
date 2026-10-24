import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '@/api/client';
import { useAuth } from '@/lib/AuthContext';
import TaskSheet from '@/components/kept/TaskSheet';
import TaskForm from '@/components/kept/TaskForm';
import ReviewStack from '@/components/kept/ReviewStack';
import ProfileSheet from '@/components/kept/ProfileSheet';

// Shared state of the "Kept" screens: tasks, suggested tasks from meetings, the people tasks go to, and the
// task sheet / form / review stack / toast that any screen can open.
const KeptContext = createContext(null);

export function KeptProvider({ children }) {
  const { workspace, updateWorkspace } = useAuth();
  const [tasks, setTasks] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [people, setPeople] = useState([]);
  const [sheet, setSheet] = useState(null); // { type: 'task', id } | { type: 'form', form }
  const [review, setReview] = useState(null); // { meetingId|null, total, approved }
  const [profile, setProfile] = useState(false);
  const [toast, setToastState] = useState(null);
  const toastTimer = useRef(null);

  const me = workspace?.mePersonId ?? null;
  const folders = workspace?.folders ?? [];

  const refresh = useCallback(async () => {
    // one failing list (or an older API without tasks) never breaks the others
    const safe = (f) =>
      Promise.resolve()
        .then(f)
        .catch(() => null);
    // Suggestions that already name a person are filed as tasks by that request, so the task list is read after it.
    const [s, p] = await Promise.all([
      safe(() => api.tasks.suggestions()),
      safe(() => api.speakers.list()),
    ]);
    const t = await safe(() => api.tasks.list());
    if (t) setTasks(t);
    else setTasks((x) => x ?? []);
    if (s) setSuggestions(s);
    if (p) setPeople(p.filter((x) => !x.anonymous));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const showToast = useCallback((msg, action) => {
    clearTimeout(toastTimer.current);
    setToastState({ msg, action });
    toastTimer.current = setTimeout(() => setToastState(null), action ? 4500 : 3000);
  }, []);

  const replace = (task) =>
    setTasks((list) => (list ?? []).map((t) => (t.id === task.id ? task : t)));

  const createTask = useCallback(async (input) => {
    const task = await api.tasks.create(input);
    setTasks((list) => [...(list ?? []), task]);
    if (input.fromSuggestion)
      setSuggestions((list) =>
        list.filter(
          (s) =>
            !(
              s.meetingId === input.fromSuggestion.meetingId &&
              s.index === input.fromSuggestion.index
            ),
        ),
      );
    return task;
  }, []);

  const updateTask = useCallback(
    async (id, patch) => {
      const before = (tasks ?? []).find((t) => t.id === id);
      // ticking a task off shows at once; the server's answer replaces it
      if (before && patch.status)
        replace({
          ...before,
          status: patch.status,
          doneAt: patch.status === 'done' ? new Date().toISOString() : null,
        });
      try {
        const task = await api.tasks.update(id, patch);
        replace(task);
        return task;
      } catch (e) {
        if (before) replace(before);
        showToast(e?.message || 'Could not save. Try again.');
        throw e;
      }
    },
    [tasks, showToast],
  );

  const removeTask = useCallback(async (id) => {
    await api.tasks.remove(id);
    setTasks((list) => (list ?? []).filter((t) => t.id !== id));
  }, []);

  const skipSuggestion = useCallback(async (s) => {
    setSuggestions((list) =>
      list.filter((x) => !(x.meetingId === s.meetingId && x.index === s.index)),
    );
    await api.tasks.skip(s.meetingId, s.index).catch(() => {});
  }, []);

  const setMe = useCallback(
    async (personId) => {
      await api.tasks.setMe(personId);
      updateWorkspace({ mePersonId: personId });
    },
    [updateWorkspace],
  );

  const value = useMemo(
    () => ({
      me,
      folders,
      tasks,
      suggestions,
      people,
      refresh,
      createTask,
      updateTask,
      removeTask,
      skipSuggestion,
      setMe,
      toast: showToast,
      openTask: (id) => setSheet({ type: 'task', id }),
      openForm: (form = {}) => setSheet({ type: 'form', form }),
      closeSheet: () => setSheet(null),
      openProfile: () => setProfile(true),
      openReview: (meetingId = null) => {
        const list = suggestions.filter((s) => !meetingId || s.meetingId === meetingId);
        if (list.length) setReview({ meetingId, total: list.length, approved: 0 });
      },
    }),
    [
      me,
      folders,
      tasks,
      suggestions,
      people,
      refresh,
      createTask,
      updateTask,
      removeTask,
      skipSuggestion,
      setMe,
      showToast,
    ],
  );

  const reviewList = review
    ? suggestions.filter((s) => !review.meetingId || s.meetingId === review.meetingId)
    : [];

  return (
    <KeptContext.Provider value={value}>
      {children}
      {review && (
        <ReviewStack
          list={reviewList}
          total={review.total}
          approved={review.approved}
          onApproved={() => setReview((r) => r && { ...r, approved: r.approved + 1 })}
          onClose={() => setReview(null)}
        />
      )}
      {profile && <ProfileSheet onClose={() => setProfile(false)} />}
      {sheet?.type === 'task' && <TaskSheet id={sheet.id} />}
      {sheet?.type === 'form' && (
        <TaskForm
          initial={sheet.form}
          onDone={() => {
            if (sheet.form.fromSuggestion)
              setReview((r) => r && { ...r, approved: r.approved + 1 });
          }}
        />
      )}
      {toast && (
        <div className="k-toast" role="status">
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action.onClick();
                setToastState(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </KeptContext.Provider>
  );
}

export function useKept() {
  const ctx = useContext(KeptContext);
  if (!ctx) throw new Error('useKept must be used within a KeptProvider');
  return ctx;
}

/** The Kept state when inside the app's layout, else null (a screen shown on its own). */
export const useKeptOptional = () => useContext(KeptContext);
