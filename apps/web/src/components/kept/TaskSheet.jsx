import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useKept } from '@/lib/keptStore';
import { Avatar, Sheet, WhatsAppIcon } from '@/components/kept/bits';
import CopyMessage from '@/components/kept/CopyMessage';
import {
  PRIORITY_LABEL,
  daysUntil,
  dueLabel,
  firstName,
  niceDay,
  reminderText,
  waLink,
} from '@/lib/kept';

/** One task: who, when, from which meeting; done / remind / edit / delete. */
export default function TaskSheet({ id }) {
  const { tasks, me, updateTask, removeTask, closeSheet, openForm, toast } = useKept();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = (tasks ?? []).find((x) => x.id === id);
  if (!t) return null;
  const late = t.status === 'open' && daysUntil(t.due) < 0;
  const reminder = reminderText(t);

  const toggle = async () => {
    const status = t.status === 'done' ? 'open' : 'done';
    await updateTask(t.id, { status }).catch(() => {});
    closeSheet();
    toast(status === 'done' ? 'Marked done.' : 'Reopened.');
  };

  return (
    <Sheet
      label={t.title}
      onClose={closeSheet}
      head={
        <span className={`k-chip ${t.status === 'done' ? 'k-ok' : late ? 'k-hi' : ''}`}>
          {t.status === 'done' ? 'Completed' : late ? 'Pending' : dueLabel(t.due)}
        </span>
      }
    >
      <div className="px-[18px] pt-1.5 pb-4">
        <h3 className="k-serif text-[30px] leading-[1.12] mt-1.5 mb-[18px]">{t.title}</h3>
        <div className="k-list">
          <div className="k-kv">
            <span className="k-k">Owner</span>
            <span className="k-v">
              <Avatar id={t.ownerId} name={t.ownerName} />
              {t.ownerName}
              {t.ownerId === me ? ' (you)' : ''}
            </span>
          </div>
          {t.buddyName && (
            <div className="k-kv">
              <span className="k-k">Buddy</span>
              <span className="k-v">
                <Avatar id={t.buddyId} name={t.buddyName} />
                {t.buddyName}
              </span>
            </div>
          )}
          <div className="k-kv">
            <span className="k-k">Deadline</span>
            <span className="k-v">{niceDay(t.due)}</span>
          </div>
          <div className={`k-kv p-${t.priority}`}>
            <span className="k-k">Priority</span>
            <span className="k-v">
              <span className="k-dot" />
              {PRIORITY_LABEL[t.priority]}
            </span>
          </div>
          {t.createdByName && (
            <div className="k-kv">
              <span className="k-k">Given by</span>
              <span className="k-v">{t.createdByName}</span>
            </div>
          )}
          {t.meetingId && (
            <button
              type="button"
              className="k-kv"
              onClick={() => {
                closeSheet();
                navigate(`/meetings/${t.meetingId}`);
              }}
            >
              <span className="k-k">Meeting</span>
              <span className="k-v truncate">{t.meetingTitle ?? 'Open meeting'}</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
        {t.source?.text && t.source.text !== t.title && (
          <p className="k-quote">“{t.source.text}”</p>
        )}

        <div className="k-list mt-3">
          <button type="button" className="k-act" onClick={toggle}>
            <span className="k-ic">
              {t.status === 'done' ? (
                <RotateCcw className="w-[18px] h-[18px]" />
              ) : (
                <Check className="w-[18px] h-[18px]" />
              )}
            </span>
            {t.status === 'done' ? 'Mark as not done' : 'Mark as done'}
          </button>
          {t.ownerId !== me && t.status === 'open' && (
            <div className="k-wa-row">
              <a
                className="k-act k-wa"
                href={waLink(reminder)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="k-ic">
                  <WhatsAppIcon />
                </span>
                Remind {firstName(t.ownerName)} on WhatsApp
              </a>
              <CopyMessage text={reminder} className="k-icon mr-3" />
            </div>
          )}
          <button
            type="button"
            className="k-act"
            onClick={() =>
              openForm({
                editId: t.id,
                title: t.title,
                ownerId: t.ownerId,
                buddyId: t.buddyId,
                priority: t.priority,
                due: t.due,
                meetingId: t.meetingId,
              })
            }
          >
            <span className="k-ic">
              <Pencil className="w-[18px] h-[18px]" />
            </span>
            Edit task
          </button>
          {confirmDelete ? (
            <div className="k-act">
              <span className="flex-1 text-sm">Delete this task?</span>
              <button
                type="button"
                className="text-sm font-semibold px-2"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="text-sm font-semibold text-[#c4614d] px-2"
                onClick={async () => {
                  await removeTask(t.id).catch(() => toast('Could not delete. Try again.'));
                  closeSheet();
                  toast('Task deleted.');
                }}
              >
                Delete
              </button>
            </div>
          ) : (
            <button type="button" className="k-act k-red" onClick={() => setConfirmDelete(true)}>
              <span className="k-ic">
                <Trash2 className="w-[18px] h-[18px]" />
              </span>
              Delete
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
