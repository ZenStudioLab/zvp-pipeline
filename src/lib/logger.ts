export type PipelineStatus =
  | 'pending'
  | 'converting'
  | 'scoring'
  | 'dedup'
  | 'published'
  | 'needs_review'
  | 'dry_run'
  | 'rejected'
  | 'failed';

export type PipelineLogEntry = {
  status: PipelineStatus;
  source_url?: string;
  quality_score?: number;
  rejection_reason?: string;
  quality_reasons?: string[];
  needs_review?: boolean;
  details?: Record<string, unknown>;
};

export type PipelineSummary = {
  processed: number;
  pending: number;
  converting: number;
  scoring: number;
  dedup: number;
  published: number;
  needs_review: number;
  dry_run: number;
  rejected: number;
  failed: number;
  averageQualityScore: number;
  autoPublishRate: number;
  reasons: Record<string, number>;
  qualityReasons: Record<string, number>;
};

export class PipelineLogger {
  private readonly entries: PipelineLogEntry[] = [];

  log(entry: PipelineLogEntry): void {
    this.entries.push(entry);
  }

  getEntries(): PipelineLogEntry[] {
    return [...this.entries];
  }

  filterByStatus(status: PipelineStatus): PipelineLogEntry[] {
    return this.entries.filter((entry) => entry.status === status);
  }

  filterByMinimumQuality(minimumScore: number): PipelineLogEntry[] {
    return this.entries.filter((entry) => (entry.quality_score ?? -1) >= minimumScore);
  }

  summarize(): PipelineSummary {
    const summary: PipelineSummary = {
      processed: 0,
      pending: 0,
      converting: 0,
      scoring: 0,
      dedup: 0,
      published: 0,
      needs_review: 0,
      dry_run: 0,
      rejected: 0,
      failed: 0,
      averageQualityScore: 0,
      autoPublishRate: 0,
      reasons: {},
      qualityReasons: {},
    };

    let qualityScoreTotal = 0;
    let qualityScoreCount = 0;
    let autoPublishedCount = 0;

    for (const entry of this.entries) {
      summary[entry.status] += 1;

      if (
        entry.status === 'published' ||
        entry.status === 'needs_review' ||
        entry.status === 'dry_run' ||
        entry.status === 'rejected' ||
        entry.status === 'failed'
      ) {
        summary.processed += 1;
      }

      if (typeof entry.quality_score === 'number') {
        qualityScoreTotal += entry.quality_score;
        qualityScoreCount += 1;
      }

      if (entry.status === 'published') {
        autoPublishedCount += 1;
      }

      if (entry.status === 'rejected' && entry.rejection_reason) {
        summary.reasons[entry.rejection_reason] = (summary.reasons[entry.rejection_reason] ?? 0) + 1;
      }

      for (const qualityReason of entry.quality_reasons ?? []) {
        summary.qualityReasons[qualityReason] = (summary.qualityReasons[qualityReason] ?? 0) + 1;
      }
    }

    summary.averageQualityScore = qualityScoreCount === 0 ? 0 : Number((qualityScoreTotal / qualityScoreCount).toFixed(6));
    summary.autoPublishRate = summary.processed === 0 ? 0 : Number((autoPublishedCount / summary.processed).toFixed(6));

    return summary;
  }

  toJson(): string {
    return JSON.stringify({ entries: this.entries, summary: this.summarize() }, null, 2);
  }
}