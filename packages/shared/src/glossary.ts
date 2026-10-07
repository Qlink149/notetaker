import { z } from 'zod';

export const GlossaryKind = z.enum([
  'company',
  'person',
  'competitor',
  'agency',
  'product',
  'place',
  'other',
]);
export type GlossaryKind = z.infer<typeof GlossaryKind>;

export const GlossaryEntry = z.object({
  term: z.string().trim().min(1).max(120),
  kind: GlossaryKind,
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  note: z.string().max(300).optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const Glossary = z.object({
  entries: z.array(GlossaryEntry).max(1000),
});
export type Glossary = z.infer<typeof Glossary>;
