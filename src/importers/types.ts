/**
 * Shared types for the import pipeline (scanner + matcher).
 *
 * These types mirror the extension export JSON shape to decouple
 * the pipeline from the midi-scraper-extension workspace.
 */

import type { ScannedFile } from './download-scanner.js';

/** x = click-to-download delay (s), y = inter-variant delay (s), z = inter-work delay (s). */
export interface TimingConfig {
  x: number;
  y: number;
  z: number;
  maxMatchingWindowSeconds?: number;
}

export type MatchConfidence = 'high' | 'medium' | 'low';
export type MatchMethod = 'time_window' | 'order_only' | 'structural';

/** Subset of the extension's ExportVariant – fields the matcher needs. */
export interface ImportExportVariant {
  difficulty_label: string;
  download_filename: string | null;
  download_started_at: string | null;
  score_id?: string;
  score_url?: string;
  [key: string]: unknown;
}

/** Subset of the extension's ExportRecord – fields the matcher needs. */
export interface ImportExportRecord {
  work_order: number;
  canonical_title: string;
  variants: ImportExportVariant[];
  [key: string]: unknown;
}

/** Result of matching one variant to one scanned file. */
export interface MatchResult {
  file: ScannedFile;
  workOrder: number;
  canonicalTitle: string;
  variant: ImportExportVariant;
  confidence: MatchConfidence;
  matchMethod: MatchMethod;
  matchReason: string;
  timeDeltaSeconds: number;
  reviewStatus?: 'needs_review';
}
