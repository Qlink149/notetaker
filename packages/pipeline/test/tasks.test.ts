import { describe, expect, it } from 'vitest';
import { draftTask, guessPriority, isoDay, parseDue, taskTitle } from '../src/tasks.js';

// Tuesday 20 Oct 2026
const base = '2026-10-20';
const due = (t: string) => parseDue(t, base).due;

describe('parseDue: deadlines counted from the meeting day', () => {
  it('reads weekdays, "next" weekdays and the end of the week', () => {
    expect(due('Share the report by Friday')).toBe('2026-10-23');
    expect(due('Share the report by Tuesday')).toBe('2026-10-27'); // said on a Tuesday: the next one
    expect(due('Top stores report by next Tuesday')).toBe('2026-10-27');
    expect(due('Plan by next Monday')).toBe('2026-10-26');
    expect(due('Close it by end of the week')).toBe('2026-10-23');
    expect(due('Review it next week')).toBe('2026-10-27');
  });

  it('reads today, tomorrow and day counts, in English and romanised Hindi/Gujarati', () => {
    expect(due('Send the budget today')).toBe(base);
    expect(due('Dispatch confirm karna kal tak')).toBe('2026-10-21');
    expect(due('Confirm dispatches by tomorrow')).toBe('2026-10-21');
    expect(due('Quote parso tak bhejna')).toBe('2026-10-22');
    expect(due('Aaj tak payment clear karo')).toBe(base);
    expect(due('Finish within 3 days')).toBe('2026-10-23');
    expect(due('Train the staff in 2 weeks')).toBe('2026-11-03');
    expect(due('Somvar tak list bhejo')).toBe('2026-10-26');
  });

  it('reads dates, rolling into next year only when well in the past', () => {
    expect(due('Training by 25 Oct')).toBe('2026-10-25');
    expect(due('Training by October 25th')).toBe('2026-10-25');
    expect(due('Launch by 5 Jan')).toBe('2027-01-05');
    expect(due('Invoice from 2 Oct to be checked')).toBe('2026-10-02');
    expect(due('Due 31 Feb')).toBeNull();
  });

  it('leaves no deadline when none is said, and does not mistake words for days', () => {
    expect(due('Follow up with Kalpesh on pricing')).toBeNull();
    expect(due('Sat with the team on the plan')).toBeNull();
    expect(due('You may send the samples')).toBeNull();
  });
});

describe('draft tasks from action items', () => {
  it('drops the deadline words from the title', () => {
    expect(taskTitle('Share the top stores report by next Tuesday.', 'by next Tuesday')).toBe(
      'Share the top stores report',
    );
    expect(draftTask('confirm pending dealer dispatches by tomorrow, it is urgent', base)).toEqual({
      title: 'Confirm pending dealer dispatches, it is urgent',
      due: '2026-10-21',
      priority: 'high',
      quote: 'confirm pending dealer dispatches by tomorrow, it is urgent',
    });
  });

  it('sets the priority from urgency, then from how soon it is due', () => {
    expect(guessPriority('Do it asap', '2026-12-01', base)).toBe('high');
    expect(guessPriority('Do it', '2026-10-21', base)).toBe('high');
    expect(guessPriority('Do it', '2026-10-23', base)).toBe('med');
    expect(guessPriority('Do it', '2026-11-20', base)).toBe('low');
    expect(guessPriority('Do it', null, base)).toBe('med');
  });

  it('isoDay uses the Indian calendar day', () => {
    expect(isoDay(new Date('2026-10-20T20:00:00Z'))).toBe('2026-10-21');
    expect(isoDay(new Date('2026-10-20T10:00:00Z'))).toBe('2026-10-20');
  });
});
