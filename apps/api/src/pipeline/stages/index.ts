import type { StageRegistry } from '../context.js';
import { ingestStage } from './10-ingest.js';
import { transcribeStage } from './20-transcribe.js';
import { assembleStage } from './30-assemble.js';
import { gapfillStage } from './35-gapfill.js';
import { summariseStage } from './40-summarise.js';
import { finaliseStage } from './90-finalise.js';
import { benchmarkStage } from './95-benchmark.js';

export const stages: StageRegistry = {
  ingest: ingestStage,
  transcribe: transcribeStage,
  assemble: assembleStage,
  gapfill: gapfillStage,
  summarise: summariseStage,
  finalise: finaliseStage,
  benchmark: benchmarkStage,
};
