import type { StageRegistry } from '../context.js';
import { multitrackStage } from './05-multitrack.js';
import { ingestStage } from './10-ingest.js';
import { transcribeStage } from './20-transcribe.js';
import { diarizeStage } from './22-diarize.js';
import { assembleStage } from './30-assemble.js';
import { gapfillStage } from './35-gapfill.js';
import { identifyStage } from './37-identify.js';
import { summariseStage } from './40-summarise.js';
import { finaliseStage } from './90-finalise.js';
import { benchmarkStage } from './95-benchmark.js';

export const stages: StageRegistry = {
  multitrack: multitrackStage,
  ingest: ingestStage,
  transcribe: transcribeStage,
  diarize: diarizeStage,
  assemble: assembleStage,
  gapfill: gapfillStage,
  identify: identifyStage,
  summarise: summariseStage,
  finalise: finaliseStage,
  benchmark: benchmarkStage,
};
