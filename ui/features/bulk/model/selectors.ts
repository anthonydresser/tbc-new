import type { BulkSlice } from '@sim/state/sim_store';

// Limits are advisory: overshooting them requires a confirmation (see BulkSettings),
// it no longer blocks the run outright.
export const canRunBatch = (slice: BulkSlice): boolean => !slice.combinationsPending && !slice.isRunning && slice.combinations > 1;

// A batch exceeds its host's ceilings when either axis (raw combination count or total
// simmed iterations) is past the limit — either one warrants the pre-run confirmation.
export const batchNeedsConfirm = (slice: BulkSlice, combinationsLimit: number, iterationsLimit: number): boolean =>
	slice.combinations > combinationsLimit || slice.iterations > iterationsLimit;
