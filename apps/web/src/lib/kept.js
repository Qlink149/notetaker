// Helpers for the "Kept" screens: calendar days, deadlines in words, avatars, WhatsApp links and the sky art
// of the client's prototype (kept-mobile.html, 20 Oct).

/** YYYY-MM-DD of a date in the local calendar. */
export function isoDay(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const noonOf = (day) => new Date(`${day}T12:00:00`);

export const today = () => isoDay();

export function addDays(n, from = today()) {
  const d = noonOf(from);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** Days from today to `day` (negative when past); a large number when there is no day. */
export function daysUntil(day) {
  if (!day) return 999;
  return Math.round((noonOf(day) - noonOf(today())) / 86_400_000);
}

/** The next given weekday (0 = Sunday) after today. */
export function nextWeekday(wd) {
  const k = (wd - noonOf(today()).getDay() + 7) % 7 || 7;
  return addDays(k);
}

export const niceDay = (day) =>
  day
    ? noonOf(day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
    : 'No date';

/** "3 days late", "Today", "Tomorrow", "Friday", "Mon, 2 Nov". */
export function dueLabel(day) {
  if (!day) return 'No date';
  const n = daysUntil(day);
  if (n < -1) return `${-n} days late`;
  if (n === -1) return '1 day late';
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 7) return noonOf(day).toLocaleDateString('en-IN', { weekday: 'long' });
  return niceDay(day);
}

export const PRIORITY_LABEL = { high: 'High', med: 'Medium', low: 'Low' };

const HUES = [
  '#8f88d9',
  '#d78fa8',
  '#7fb39b',
  '#d9a650',
  '#6fa3c9',
  '#b38ad1',
  '#e0806c',
  '#6c9c8f',
  '#c69472',
  '#8299d4',
];

/** A steady colour per person (from their id). */
export function hueOf(id) {
  let h = 0;
  for (const c of String(id ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return id ? HUES[h % HUES.length] : '#b8bccb';
}

export function initialsOf(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

export const firstName = (name) =>
  String(name ?? '')
    .trim()
    .split(/\s+/)[0] || 'Someone';

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5
    ? 'Good night'
    : h < 12
      ? 'Good morning'
      : h < 17
        ? 'Good afternoon'
        : 'Good evening';
}

export const waLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** WhatsApp reminder for one task. */
export function reminderText(task) {
  return [
    `Hi ${firstName(task.ownerName)}, a quick reminder 🙂`,
    '',
    `*${task.title}*`,
    `Due: ${dueLabel(task.due)}${task.due ? ` (${niceDay(task.due)})` : ''}`,
    ...(task.buddyName ? [`With: ${task.buddyName}`] : []),
    ...(task.meetingTitle ? [`From: ${task.meetingTitle}`] : []),
  ].join('\n');
}

/** WhatsApp check-in for everything a person has open. */
export function nudgeText(name, tasks) {
  return [
    `Hi ${firstName(name)}, quick check-in on:`,
    '',
    ...tasks.map((t) => `• *${t.title}* — ${dueLabel(t.due)}`),
    '',
    'All good? 🙂',
  ].join('\n');
}

// ---------- sky art ----------
const PHASES = {
  morning: {
    sky: ['#f8dcc8', '#efcfdc', '#c8d2f1'],
    sun: '#fff3e3',
    mt: ['#e2c9df', '#c4b3d9', '#9a9bcc', '#7b80bb'],
    text: 'light',
  },
  afternoon: {
    sky: ['#cfe6f2', '#dbe8f4', '#f1eff6'],
    sun: '#ffffff',
    mt: ['#c3d9e6', '#a2c3d6', '#7fa8c2', '#6790ad'],
    text: 'light',
  },
  evening: {
    sky: ['#f6c7b4', '#e3abc6', '#9f9ed6'],
    sun: '#ffe6d2',
    mt: ['#d3a3c4', '#a98bbd', '#7d77b0', '#5c5f9c'],
    text: 'dark',
  },
  night: {
    sky: ['#2c335e', '#4a4d84', '#8778ad'],
    sun: '#f1ebff',
    mt: ['#57558c', '#434476', '#30335f', '#20234a'],
    text: 'dark',
  },
};

export function phaseNow(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 11
    ? 'morning'
    : h >= 11 && h < 16
      ? 'afternoon'
      : h >= 16 && h < 20
        ? 'evening'
        : 'night';
}

/** Whether text on the sky of `phase` should be light (white) or dark. */
export const textOn = (phase) => (PHASES[phase].text === 'dark' ? 'dark' : 'light');

function ridge(base, amp, seed, step = 36) {
  const pts = [];
  for (let x = -20; x <= 440; x += step) {
    const y =
      base -
      amp *
        (0.55 * Math.sin(x * 0.012 + seed) +
          0.3 * Math.sin(x * 0.031 + seed * 2.3) +
          0.15 * Math.sin(x * 0.07 + seed * 4.1));
    pts.push([x, y]);
  }
  let d = `M-20 320 L${pts[0][0]} ${pts[0][1].toFixed(1)} `;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    d += `Q${x0.toFixed(1)} ${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)} `;
  }
  return `${d}L440 320 Z`;
}

let artCount = 0;

/** Layered mountains under a sky for the time of day, as an SVG string. */
export function skyArt({
  phase = phaseNow(),
  fade = true,
  seed = 1.7,
  sunX = 300,
  sunY = 88,
} = {}) {
  const ph = PHASES[phase];
  const id = `ka${++artCount}`;
  const layers = [
    [150, 26, seed, '0.75', 1.6],
    [178, 30, seed + 1.9, '0.82', 1],
    [210, 24, seed + 3.3, '0.9', 0.5],
    [238, 18, seed + 5.1, '1', 0],
  ];
  return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>
<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ph.sky[2]}"/><stop offset=".55" stop-color="${ph.sky[1]}"/><stop offset="1" stop-color="${ph.sky[0]}"/></linearGradient>
<radialGradient id="${id}g"><stop offset="0" stop-color="${ph.sun}" stop-opacity=".95"/><stop offset=".35" stop-color="${ph.sun}" stop-opacity=".45"/><stop offset="1" stop-color="${ph.sun}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".55"/></linearGradient>
<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#f6f5fa" stop-opacity="0"/><stop offset="1" stop-color="#f6f5fa" stop-opacity="${fade ? '.85' : '0'}"/></linearGradient>
${layers.map((l, i) => `<filter id="${id}b${i}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${l[4]}"/></filter>`).join('')}
</defs>
<rect width="400" height="300" fill="url(#${id}s)"/>
<circle cx="${sunX}" cy="${sunY}" r="120" fill="url(#${id}g)"/><circle cx="${sunX}" cy="${sunY}" r="22" fill="${ph.sun}" opacity=".9"/>
<ellipse cx="90" cy="70" rx="120" ry="16" fill="#fff" opacity=".18"/><ellipse cx="260" cy="140" rx="160" ry="12" fill="#fff" opacity=".14"/>
${layers.map((l, i) => `<path d="${ridge(l[0], l[1], l[2])}" fill="${ph.mt[i]}" opacity="${l[3]}" filter="url(#${id}b${i})"/><rect y="${l[0] - 30}" width="400" height="80" fill="url(#${id}m)" opacity=".5"/>`).join('')}
<rect width="400" height="300" fill="url(#${id}f)"/></svg>`;
}
