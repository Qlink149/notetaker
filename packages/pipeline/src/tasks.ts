/**
 * Turning a summary's action items into suggested tasks: a deadline read from the words ("by Friday",
 * "kal tak", "25 Oct"), counted from the day of the meeting rather than today, a priority, and the title
 * without the deadline phrase. Pure: the API adds the owner (a person in the workspace).
 */

export type TaskPriority = 'high' | 'med' | 'low';

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a date, in the calendar of `tzOffsetMin` (India by default). */
export function isoDay(d: Date, tzOffsetMin = 330): string {
  return new Date(d.getTime() + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();

/** The next `wd` (0 = Sunday) after `day`; a week later when `day` is that weekday. */
const nextWeekday = (day: string, wd: number): string => {
  const k = (wd - weekday(day) + 7) % 7 || 7;
  return addDays(day, k);
};

const DAYS: Record<string, number> = {
  sunday: 0,
  ravivar: 0,
  raviwar: 0,
  mon: 1,
  monday: 1,
  somvar: 1,
  somwar: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  mangalvar: 2,
  mangalwar: 2,
  wed: 3,
  wednesday: 3,
  budhvar: 3,
  budhwar: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  guruvar: 4,
  guruwar: 4,
  fri: 5,
  friday: 5,
  shukravar: 5,
  shukrawar: 5,
  saturday: 6,
  shanivar: 6,
  shaniwar: 6,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DW = `(${Object.keys(DAYS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;
const MO =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PRE = '(?:by|before|on|till|until|due|latest by|within)';

/** A date in the year of `base`, or the next year when it would fall more than a month before `base`. */
function dayMonth(base: string, day: number, month: number): string | null {
  if (month < 0 || day < 1 || day > 31) return null;
  let year = Number(base.slice(0, 4));
  const make = (y: number): string | null => {
    const d = new Date(Date.UTC(y, month, day, 12));
    return d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
  };
  let out = make(year);
  if (out && Date.parse(out) < Date.parse(base) - 31 * DAY_MS) out = make(++year);
  return out;
}

/**
 * The deadline in `text`, counted from `base` (the meeting's day, YYYY-MM-DD), and the words that said it.
 * English and the usual romanised Hindi/Gujarati ("kal", "parso", "agle hafte", "somvar tak").
 */
export function parseDue(text: string, base: string): { due: string | null; match: string } {
  const R = (p: string): RegExp => new RegExp(p, 'i');
  let m: RegExpMatchArray | null;
  if ((m = text.match(R(`\\b(?:${PRE}\\s+)?(?:next|agle|aavta)\\s+${DW}\\b`)))) {
    // "next Tuesday": the Tuesday of the following week
    const toMonday = (8 - weekday(base)) % 7 || 7;
    return { due: addDays(base, toMonday + ((DAYS[m[1]!.toLowerCase()]! + 6) % 7)), match: m[0] };
  }
  if (
    (m = text.match(
      R(
        `\\b(?:${PRE}\\s+)?(?:the\\s+)?(?:end\\s+of\\s+(?:the\\s+|this\\s+)?week|eow|week\\s+end)\\b`,
      ),
    ))
  )
    return { due: nextWeekday(addDays(base, -1), 5), match: m[0] };
  if ((m = text.match(R(`\\b(?:${PRE}\\s+)?(?:next\\s+week|agle\\s+hafte|aavta\\s+athvadiye)\\b`))))
    return { due: addDays(base, 7), match: m[0] };
  if (
    (m = text.match(
      R(
        `\\b(?:${PRE}\\s+)?(?:today|tonight|eod|end\\s+of\\s+(?:the\\s+)?day|aaj|aje)(?:\\s+tak)?\\b`,
      ),
    ))
  )
    return { due: base, match: m[0] };
  if (
    (m = text.match(
      R(`\\b(?:${PRE}\\s+)?(?:day\\s+after\\s+tomorrow|parso|parson)(?:\\s+tak)?\\b`),
    ))
  )
    return { due: addDays(base, 2), match: m[0] };
  if (
    (m = text.match(R(`\\b(?:${PRE}\\s+)?(?:tomorrow|tmrw|kal|kale|aavti\\s+kale)(?:\\s+tak)?\\b`)))
  )
    return { due: addDays(base, 1), match: m[0] };
  if ((m = text.match(R(`\\b(?:in|within)\\s+(\\d{1,3})\\s+(day|week)s?\\b`))))
    return {
      due: addDays(base, Number(m[1]) * (m[2]!.toLowerCase() === 'week' ? 7 : 1)),
      match: m[0],
    };
  if ((m = text.match(R(`\\b(?:${PRE}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MO}\\b`)))) {
    const d = dayMonth(base, Number(m[1]), MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()));
    if (d) return { due: d, match: m[0] };
  }
  if ((m = text.match(R(`\\b(?:${PRE}\\s+)?${MO}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
    const d = dayMonth(base, Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()));
    if (d) return { due: d, match: m[0] };
  }
  if ((m = text.match(R(`\\b(?:${PRE}\\s+)?(?:this\\s+)?${DW}(?:\\s+tak)?\\b`))))
    // "by Tuesday" said on a Tuesday means the next one
    return { due: nextWeekday(base, DAYS[m[1]!.toLowerCase()]!), match: m[0] };
  return { due: null, match: '' };
}

const URGENT = /\b(urgent(?:ly)?|asap|immediately|critical|top priority|jaldi|turant)\b/i;

/** High when urgent or due within a day of the meeting, medium within four days, else low. */
export function guessPriority(text: string, due: string | null, base: string): TaskPriority {
  if (URGENT.test(text)) return 'high';
  if (!due) return 'med';
  const days = Math.round((Date.parse(due) - Date.parse(base)) / DAY_MS);
  return days <= 1 ? 'high' : days <= 4 ? 'med' : 'low';
}

/** The action item as a task title: without the deadline words, urgency words and trailing punctuation. */
export function taskTitle(text: string, match: string): string {
  let t = match ? text.replace(match, ' ') : text;
  t = t
    .replace(/,?\s*(?:it'?s|this is)\s+(?:urgent|important|critical|a priority)/i, ' ')
    .replace(/\b(?:asap|urgently)\b/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/[\s,;:.!-]+$/, '')
    .replace(/\s+(?:by|before|on|till|until|tak)$/i, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : text.trim();
}

export interface DraftTask {
  title: string;
  due: string | null;
  priority: TaskPriority;
  /** The action item as written. */
  quote: string;
}

/** One action item → a draft task (owner left to the caller). */
export function draftTask(text: string, base: string): DraftTask {
  const { due, match } = parseDue(text, base);
  return {
    title: taskTitle(text, match),
    due,
    priority: guessPriority(text, due, base),
    quote: text,
  };
}
