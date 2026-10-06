import type { Turn } from '@meetingid/shared';

export function turn(speaker: string, start: number, end: number, text: string): Turn {
  return { speaker, start, end, textRoman: text, textNative: text, lang: 'mixed' };
}

/** Distinct, deterministic sentences so similarity only matches what a test intends. */
export const sentences = [
  'aaj hum quarterly sales numbers discuss karenge',
  'Kisna ka franchise model bahut strong hai',
  'CaratLane aur Tanishq ka pricing compare karo',
  'next week tak report bhejna zaroori hai',
  'store visit ke baad feedback share karna',
  'marketing budget thoda badhana padega',
  'Gujarat region mein demand acchi hai',
  'inventory turnover pe focus karna hai',
  'diamond certification process simple karo',
  'customer complaints ka analysis chahiye',
  'festive season ke liye stock plan banao',
  'training sessions har mahine honge',
];
