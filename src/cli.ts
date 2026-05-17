import { Command } from 'commander';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';

import { loadPipelineEnvFile } from './env.js';
import { createPipelineRuntimeRepository } from './lib/runtime-repository.js';
import { PipelineLogger } from './lib/logger.js';
import { processPipelineJob } from './lib/process-job.js';
import { evaluatePipelineStages } from './lib/run-stages.js';
import { determinePublicationOutcome } from './stages/publisher.js';
import { scanDownloadDirectory } from './importers/download-scanner.js';
import { matchFilesToRecords } from './importers/time-window-matcher.js';
import { uploadAsset } from './importers/asset-uploader.js';
import { writeCatalog } from './importers/catalog-writer.js';
import { createImportRun, createImportEvent, updateImportRun } from './importers/import-audit.js';
import { adaptScraperExportRecords } from './importers/provider-adapter.js';
import { createStorageClientFromEnv, downloadFromStorage } from './lib/storage-client.js';
import type { MatchConfidence, MatchMethod, TimingConfig } from './importers/types.js';
import type { ImportDiagnostic, NormalizedImportRecord, NormalizedImportVariant, RawScraperRecord } from './importers/provider-adapter.js';
import type { ScannedFile } from './importers/download-scanner.js';
import type { StorageClient } from './importers/asset-uploader.js';
import type { ZenDatabase } from '@zen/db';
import { arrangement, pipelineJob, sheetAsset, work } from '@zen/db';
import type { SourceDifficultyLabel } from './stages/canonical-selector.js';

// ── Types ────────────────────────────────────────────────────────────────────

type RunCommandOptions = {
	source?: string;
	limit: number;
	file?: string;
	dryRun: boolean;
	skipRevalidation: boolean;
	status?: string;
	concurrency: number;
	sourceItems?: boolean;
	forceGenerate?: boolean;
	arrangementId?: string;
	reason?: string;
	publish?: boolean;
	retryFailed?: boolean;
	requeueStranded?: boolean;
};

type ImportCommandOptions = {
	exportFile: string;
	downloadDir: string;
	timingX?: number;
	timingY?: number;
	timingZ?: number;
	maxMatchingWindowSeconds?: number;
	limit?: number;
	dryRun: boolean;
};

type ImportStats = {
	filesScanned: number;
	filesMatched: number;
	filesUploaded: number;
	rowsCreated: number;
	dryRun: boolean;
	importRunId: string | null;
	diagnostics?: ImportDiagnostic[];
	matchedFileDetails?: ImportMatchedFileDetail[];
	unmatchedLocalFileDetails?: ImportUnmatchedLocalFileDetail[];
	unmatchedExportVariantDetails?: ImportUnmatchedExportVariantDetail[];
};

type ImportUploadDetail = {
	performed: boolean;
	reused: boolean;
	assetId: string | null;
	publicUrl: string | null;
	byteSize: number | null;
};

type ImportCatalogDetail = {
	performed: boolean;
	arrangementId: string | null;
	arrangementNew: boolean;
	pipelineJobId: string | null;
	pipelineJobNew: boolean;
};

type ImportMatchedFileDetail = {
	localFilePath: string;
	localFilename: string;
	localFileBirthtime: string;
	exportTitle: string;
	exportSourceUrl: string;
	exportDifficultyLabel: string | null;
	exportDownloadStartedAt: string | null;
	matchMethod: MatchMethod;
	confidence: MatchConfidence;
	timeDeltaSeconds: number;
	maxMatchingWindowSeconds: number;
	windowDescription: string;
	reviewStatus: 'needs_review' | null;
	upload: ImportUploadDetail;
	catalog: ImportCatalogDetail;
};

type ImportNearestCandidateDetail = {
	exportTitle: string;
	exportSourceUrl: string;
	exportDifficultyLabel: string | null;
	exportDownloadStartedAt: string | null;
	timeDeltaSeconds: number;
	maxMatchingWindowSeconds: number;
	windowDescription?: string;
	alreadyMatchedToOtherFile?: boolean;
};

type ImportCandidateComparisonDetail = {
	exportTitle: string;
	exportSourceUrl: string;
	exportDifficultyLabel: string | null;
	exportDownloadStartedAt: string | null;
	timeDeltaSeconds: number | null;
	withinMatchingWindow: boolean;
	alreadyMatchedToOtherFile: boolean;
};

type ImportSummary = {
	scannedLocalFiles: number;
	matchedFiles: number;
	unmatchedLocalFiles: number;
	newUploads: number;
	reusedAssets: number;
	catalogRowsProcessed: number;
	catalogRowsWritten: number;
	matchedFileDetails: ImportMatchedFileDetail[];
	unmatchedLocalFileDetails: ImportUnmatchedLocalFileDetail[];
	unmatchedExportVariantDetails: ImportUnmatchedExportVariantDetail[];
	explanation: string;
};

type ImportUnmatchedLocalFileDetail = {
	localFilePath: string;
	localFilename: string;
	localFileBirthtime: string;
	reasonCode: string;
	reasonMessage: string;
	nearestCandidate: ImportNearestCandidateDetail | null;
	candidateComparisons: ImportCandidateComparisonDetail[];
};

type ImportUnmatchedExportVariantDetail = {
	exportTitle: string | null;
	exportSourceUrl: string | null;
	exportDifficultyLabel: string | null;
	reasonCode: string;
	reasonMessage: string;
	nearestCandidate: {
		localFilePath?: string;
		localFilename?: string;
		localFileBirthtime?: string;
		timeDeltaSeconds: number;
		maxMatchingWindowSeconds: number;
		alreadyMatchedToOtherFile?: boolean;
		windowDescription?: string;
	} | null;
};

type PipelineStats = Awaited<ReturnType<Awaited<ReturnType<typeof createPipelineRuntimeRepository>>['getStats']>>;

export type CliDependencies = {
	runCommand(options: RunCommandOptions): Promise<unknown>;
	importCommand(options: ImportCommandOptions): Promise<ImportStats>;
	statsCommand(): Promise<PipelineStats>;
	seedCommand(): Promise<{ difficulties: number; genres: number }>;
	dispose?(): Promise<void>;
	stdout(message: string): void;
	stderr(message: string): void;
};

type CatalogEntry = {
	title: string;
	artist: string;
	source_url: string;
	output_path: string;
	comments: string[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const COMMENT_MAX_LENGTH = 500;
const VALID_STATUS_FILTERS = ['pending', 'converting', 'scoring', 'dedup', 'published', 'needs_review', 'rejected', 'failed'] as const;
const DEFAULT_IMPORT_DOWNLOAD_DIR = path.join(homedir(), 'Downloads', 'midi-scraper');
const DEFAULT_IMPORT_EXPORT_FILE = path.join(DEFAULT_IMPORT_DOWNLOAD_DIR, 'scraper-export.json');
const DEFAULT_IMPORT_TIMING: TimingConfig = { x: 8, y: 20, z: 10 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCatalogComments(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map((value) => (value.length <= COMMENT_MAX_LENGTH ? value : value.slice(0, COMMENT_MAX_LENGTH).trim()));
}

function resolveSourceSite(sourceUrl: string): string {
	if (!/^https?:\/\//i.test(sourceUrl)) {
		return 'file';
	}

	const hostname = new URL(sourceUrl).hostname.toLocaleLowerCase();
	if (hostname.includes('freemidi')) {
		return 'freemidi';
	}

	if (hostname.includes('bitmidi')) {
		return 'bitmidi';
	}

	return hostname.replace(/^www\./, '');
}

function resolveWorkspaceRoot(startDirectory = process.cwd()): string {
	let currentDirectory = path.resolve(startDirectory);

	while (currentDirectory !== path.dirname(currentDirectory)) {
		if (existsSync(path.join(currentDirectory, 'midi-scraper', 'catalog.json'))) {
			return currentDirectory;
		}

		currentDirectory = path.dirname(currentDirectory);
	}

	throw new Error('Unable to locate the workspace root from the current working directory.');
}

async function loadCatalogEntries(workspaceRoot: string): Promise<CatalogEntry[]> {
	const catalogPath = path.join(workspaceRoot, 'midi-scraper', 'catalog.json');
	const raw = await fs.readFile(catalogPath, 'utf8');
	const parsed = JSON.parse(raw) as { entries?: Array<Record<string, unknown>> };

	return (parsed.entries ?? []).map((entry) => ({
		title: typeof entry.title === 'string' ? entry.title : '',
		artist: typeof entry.artist === 'string' ? entry.artist : '',
		source_url: typeof entry.source_url === 'string' ? entry.source_url : '',
		output_path: typeof entry.output_path === 'string' ? entry.output_path : '',
		comments: normalizeCatalogComments(entry.comments),
	}));
}

async function mapWithConcurrency<T, TResult>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
	if (items.length === 0) {
		return [];
	}

	const results = new Array<TResult>(items.length);
	let currentIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (currentIndex < items.length) {
				const itemIndex = currentIndex;
				currentIndex += 1;
				results[itemIndex] = await worker(items[itemIndex]);
			}
		}),
	);

	return results;
}

function formatStats(stats: PipelineStats): string {
	const totalJobs = Math.max(stats.totalJobs, 1);
	const publishedRate = ((stats.published / totalJobs) * 100).toFixed(1);
	const reviewRate = ((stats.reviewQueue / totalJobs) * 100).toFixed(1);
	const rejectedRate = ((stats.rejected / totalJobs) * 100).toFixed(1);
	const failedRate = ((stats.failed / totalJobs) * 100).toFixed(1);

	const lines = [
		'Pipeline Stats',
		'──────────────────────────────',
		`Total jobs:        ${stats.totalJobs}`,
		`Published:         ${stats.published} (${publishedRate}%)`,
		`Review queue:      ${stats.reviewQueue} (${reviewRate}%)`,
		`Rejected:          ${stats.rejected} (${rejectedRate}%)`,
		`Failed:            ${stats.failed} (${failedRate}%)`,
		`Avg quality score: ${stats.averageQualityScore.toFixed(2)}`,
		'──────────────────────────────',
		'Reject reasons:',
	];

	const reasons = Object.entries(stats.reasons);
	if (reasons.length === 0) {
		lines.push('  none');
	} else {
		for (const [reason, count] of reasons) {
			lines.push(`  ${reason}: ${count}`);
		}
	}

	return lines.join('\n');
}

function formatInventoryWarning(warning: {
	kind: string;
	sourceUrl: string;
	status: string;
	state: string;
	phase: string | null;
	processedAt: string | Date | null;
	phaseStartedAt: string | Date | null;
}): string {
	const phaseStartedAt = warning.phaseStartedAt ? new Date(warning.phaseStartedAt).toISOString() : 'null';
	return `[stranded] kind=${warning.kind} sourceUrl=${warning.sourceUrl} status=${warning.status} state=${warning.state} phase=${warning.phase ?? 'null'} phaseStartedAt=${phaseStartedAt}`;
}

function timingValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function resolveImportTimingConfig(
	exportJson: { timing_config?: unknown; records?: RawScraperRecord[] },
	options: Pick<ImportCommandOptions, 'timingX' | 'timingY' | 'timingZ' | 'maxMatchingWindowSeconds'>,
): TimingConfig {
	const firstRecordTiming = exportJson.records?.find((record) => record.timing_config)?.timing_config;
	const rawTiming = (exportJson.timing_config ?? firstRecordTiming) as Record<string, unknown> | undefined;

	return {
		x: options.timingX ?? timingValue(rawTiming?.x) ?? DEFAULT_IMPORT_TIMING.x,
		y: options.timingY ?? timingValue(rawTiming?.y) ?? DEFAULT_IMPORT_TIMING.y,
		z: options.timingZ ?? timingValue(rawTiming?.z) ?? DEFAULT_IMPORT_TIMING.z,
		maxMatchingWindowSeconds:
			options.maxMatchingWindowSeconds ?? timingValue(rawTiming?.maxMatchingWindowSeconds ?? rawTiming?.max_matching_window_seconds),
	};
}

function maxMatchingWindowSeconds(timingConfig: TimingConfig): number {
	return timingConfig.maxMatchingWindowSeconds ?? 60;
}

function buildImportSummary(stats: ImportStats): ImportSummary {
	const unmatchedLocalFiles = Math.max(0, stats.filesScanned - stats.filesMatched);
	const reusedAssets = stats.dryRun ? 0 : Math.max(0, stats.filesMatched - stats.filesUploaded);
	const explanationParts: string[] = [];

	if (stats.dryRun) {
		explanationParts.push('Dry run skipped uploads and catalog writes.');
	}

	if (unmatchedLocalFiles > 0) {
		explanationParts.push(`${unmatchedLocalFiles} local file(s) did not match any export record.`);
	}

	if (reusedAssets > 0) {
		explanationParts.push(`${reusedAssets} matched file(s) reused existing assets, so only ${stats.filesUploaded} new upload(s) were needed.`);
	}

	if (explanationParts.length === 0) {
		explanationParts.push('All scanned files matched and created new uploads and catalog rows.');
	}

	return {
		scannedLocalFiles: stats.filesScanned,
		matchedFiles: stats.filesMatched,
		unmatchedLocalFiles,
		newUploads: stats.filesUploaded,
		reusedAssets,
		catalogRowsProcessed: stats.dryRun ? 0 : stats.filesMatched,
		catalogRowsWritten: stats.rowsCreated,
		matchedFileDetails: stats.matchedFileDetails ?? [],
		unmatchedLocalFileDetails: stats.unmatchedLocalFileDetails ?? [],
		unmatchedExportVariantDetails: stats.unmatchedExportVariantDetails ?? [],
		explanation: explanationParts.join(' '),
	};
}

function buildImportMatchDetails(input: {
	files: ScannedFile[];
	records: NormalizedImportRecord[];
	matches: Array<{
		file: ScannedFile;
		variant: NormalizedImportVariant;
		matchMethod: MatchMethod;
		confidence: MatchConfidence;
		timeDeltaSeconds: number;
		matchReason: string;
		reviewStatus?: 'needs_review';
	}>;
	uploadByPath: Map<string, ImportUploadDetail>;
	catalogByPath: Map<string, ImportCatalogDetail>;
	unmatchedFiles: ScannedFile[];
	timingConfig: TimingConfig;
}): {
	matchedFileDetails: ImportMatchedFileDetail[];
	unmatchedLocalFileDetails: ImportUnmatchedLocalFileDetail[];
	unmatchedExportVariantDetails: ImportUnmatchedExportVariantDetail[];
} {
	const matchedFileDetails = input.matches.map((match) => ({
		localFilePath: match.file.absolutePath,
		localFilename: match.file.filename,
		localFileBirthtime: match.file.birthtime.toISOString(),
		exportTitle: match.variant.title,
		exportSourceUrl: match.variant.source_url,
		exportDifficultyLabel: match.variant.difficulty_label ?? null,
		exportDownloadStartedAt: match.variant.download_started_at ?? null,
		matchMethod: match.matchMethod,
		confidence: match.confidence,
		timeDeltaSeconds: match.timeDeltaSeconds,
		maxMatchingWindowSeconds: maxMatchingWindowSeconds(input.timingConfig),
		windowDescription: match.matchReason,
		reviewStatus: match.reviewStatus ?? null,
		upload: input.uploadByPath.get(match.file.absolutePath) ?? {
			performed: false,
			reused: false,
			assetId: null,
			publicUrl: null,
			byteSize: null,
		},
		catalog: input.catalogByPath.get(match.file.absolutePath) ?? {
			performed: false,
			arrangementId: null,
			arrangementNew: false,
			pipelineJobId: null,
			pipelineJobNew: false,
		},
	}));

	const matchedVariants = new Set(input.matches.map((match) => match.variant));
	const unmatchedLocalFileDetails = input.unmatchedFiles.map((file) => {
		const nearestCandidate = findNearestVariantCandidate(file, input.records, input.timingConfig, matchedVariants);
		const hasVariants = input.records.some((record) => record.variants.length > 0);
		const hasTimestampedVariants = input.records.some((record) => record.variants.some((variant) => Boolean(variant.download_started_at)));
		const reasonCode = !hasVariants
			? 'no_export_variants'
			: !hasTimestampedVariants
				? 'missing_timestamp'
				: nearestCandidate?.alreadyMatchedToOtherFile && nearestCandidate.timeDeltaSeconds <= (input.timingConfig.maxMatchingWindowSeconds ?? 60)
					? 'already_consumed_by_better_match'
					: 'outside_window';
		return {
			localFilePath: file.absolutePath,
			localFilename: file.filename,
			localFileBirthtime: file.birthtime.toISOString(),
			reasonCode,
			reasonMessage: nearestCandidate
				? reasonCode === 'already_consumed_by_better_match'
					? `Nearest export variant was already matched to another file; it was ${nearestCandidate.timeDeltaSeconds.toFixed(1)}s away. ${nearestCandidate.windowDescription ?? ''}`.trim()
					: reasonCode === 'missing_timestamp'
						? 'Export variants exist but none have a usable download_started_at timestamp.'
						: `Nearest export variant was ${nearestCandidate.timeDeltaSeconds.toFixed(1)}s away, outside the ${input.timingConfig.maxMatchingWindowSeconds ?? 60}s window. ${nearestCandidate.windowDescription ?? ''}`.trim()
				: reasonCode === 'missing_timestamp'
					? 'Export variants exist but none have a usable download_started_at timestamp.'
					: 'No export variant was available within the timing window.',
			nearestCandidate,
			candidateComparisons: buildLocalFileCandidateComparisons(file, input.records, input.timingConfig, matchedVariants),
		};
	});

	const unmatchedExportVariantDetails = buildUnmatchedExportVariantDetails(
		input.records,
		matchedVariants,
		input.files,
		input.timingConfig,
		new Set(input.matches.map((match) => match.file.absolutePath)),
	);

	return {
		matchedFileDetails,
		unmatchedLocalFileDetails,
		unmatchedExportVariantDetails,
	};
}

function findNearestVariantCandidate(
	file: ScannedFile,
	records: NormalizedImportRecord[],
	timingConfig: TimingConfig,
 	matchedVariants: Set<NormalizedImportVariant>,
): ImportNearestCandidateDetail | null {
	let best: ImportNearestCandidateDetail | null = null;
	const windowSeconds = maxMatchingWindowSeconds(timingConfig);
	for (const record of records) {
		for (const variant of record.variants) {
			if (!variant.download_started_at) continue;
			const startedAtMs = new Date(variant.download_started_at).getTime();
			if (Number.isNaN(startedAtMs)) continue;
			const deltaSeconds = Math.abs(file.birthtime.getTime() - startedAtMs) / 1000;
			if (!best || deltaSeconds < best.timeDeltaSeconds) {
				best = {
					exportTitle: record.canonical_title,
					exportSourceUrl: variant.source_url,
					exportDifficultyLabel: variant.difficulty_label ?? null,
					exportDownloadStartedAt: variant.download_started_at,
					timeDeltaSeconds: Math.round(deltaSeconds * 10) / 10,
					maxMatchingWindowSeconds: windowSeconds,
					alreadyMatchedToOtherFile: matchedVariants.has(variant),
					windowDescription: deltaSeconds <= windowSeconds
						? `Closest candidate within ${windowSeconds}s window.`
						: `Closest candidate is ${Math.round(deltaSeconds * 10) / 10}s away, outside the ${windowSeconds}s window.`,
				};
			}
		}
	}
	return best;
}

function buildLocalFileCandidateComparisons(
	file: ScannedFile,
	records: NormalizedImportRecord[],
	timingConfig: TimingConfig,
	matchedVariants: Set<NormalizedImportVariant>,
): ImportCandidateComparisonDetail[] {
	const windowSeconds = maxMatchingWindowSeconds(timingConfig);
	return records.flatMap((record) => (record.variants as NormalizedImportVariant[]).map((variant) => {
		const startedAt = variant.download_started_at ?? null;
		const startedAtMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
		const deltaSeconds = Number.isNaN(startedAtMs)
			? null
			: Math.round((Math.abs(file.birthtime.getTime() - startedAtMs) / 1000) * 10) / 10;
		return {
			exportTitle: record.canonical_title,
			exportSourceUrl: variant.source_url,
			exportDifficultyLabel: variant.difficulty_label ?? null,
			exportDownloadStartedAt: startedAt,
			timeDeltaSeconds: deltaSeconds,
			withinMatchingWindow: deltaSeconds !== null && deltaSeconds <= windowSeconds,
			alreadyMatchedToOtherFile: matchedVariants.has(variant),
		};
	})).sort((a, b) => (a.timeDeltaSeconds ?? Number.POSITIVE_INFINITY) - (b.timeDeltaSeconds ?? Number.POSITIVE_INFINITY));
}

function buildUnmatchedExportVariantDetails(
	records: NormalizedImportRecord[],
	matchedVariants: Set<NormalizedImportVariant>,
	files: ScannedFile[],
	timingConfig: TimingConfig,
	matchedFiles: Set<string>,
): ImportUnmatchedExportVariantDetail[] {
	const details: ImportUnmatchedExportVariantDetail[] = [];
	const windowSeconds = maxMatchingWindowSeconds(timingConfig);
	for (const record of records) {
		for (const variant of record.variants) {
			if (matchedVariants.has(variant)) continue;
			const nearestCandidate = findNearestFileCandidate(variant, files, timingConfig, matchedFiles);
			details.push({
				exportTitle: record.canonical_title,
				exportSourceUrl: variant.source_url,
				exportDifficultyLabel: variant.difficulty_label ?? null,
				reasonCode: !files.length
					? 'no_local_files'
					: nearestCandidate?.alreadyMatchedToOtherFile && nearestCandidate.timeDeltaSeconds <= windowSeconds
						? 'already_consumed_by_better_match'
						: 'no_local_file_in_window',
				reasonMessage: nearestCandidate
					? nearestCandidate.alreadyMatchedToOtherFile && nearestCandidate.timeDeltaSeconds <= windowSeconds
						? `Nearest local file was already matched to another export variant; it was ${nearestCandidate.timeDeltaSeconds.toFixed(1)}s away. ${nearestCandidate.windowDescription ?? ''}`.trim()
						: `No local file remained within the timing window; nearest local file was ${nearestCandidate.timeDeltaSeconds.toFixed(1)}s away. ${nearestCandidate.windowDescription ?? ''}`.trim()
					: 'No local file was available for this export variant.',
				nearestCandidate,
			});
		}
	}
	return details;
}

function findNearestFileCandidate(
	variant: NormalizedImportVariant,
	files: ScannedFile[],
	timingConfig: TimingConfig,
	matchedFiles: Set<string>,
): ImportUnmatchedExportVariantDetail['nearestCandidate'] {
	if (!variant.download_started_at) return null;
	const startedAtMs = new Date(variant.download_started_at).getTime();
	if (Number.isNaN(startedAtMs)) return null;
	let best: ImportUnmatchedExportVariantDetail['nearestCandidate'] = null;
	const windowSeconds = maxMatchingWindowSeconds(timingConfig);
	for (const file of files) {
		const deltaSeconds = Math.abs(file.birthtime.getTime() - startedAtMs) / 1000;
		if (!best || deltaSeconds < best.timeDeltaSeconds) {
			best = {
				localFilePath: file.absolutePath,
				localFilename: file.filename,
				localFileBirthtime: file.birthtime.toISOString(),
				timeDeltaSeconds: Math.round(deltaSeconds * 10) / 10,
				maxMatchingWindowSeconds: windowSeconds,
				alreadyMatchedToOtherFile: matchedFiles.has(file.absolutePath),
				windowDescription: deltaSeconds <= windowSeconds
					? `Closest candidate within ${windowSeconds}s window.`
					: `Closest candidate is ${Math.round(deltaSeconds * 10) / 10}s away, outside the ${windowSeconds}s window.`,
			};
		}
	}
	return best;
}

// ── Default dependencies factory ─────────────────────────────────────────────

async function createDefaultDependencies(options: { skipRevalidation?: boolean } = {}): Promise<CliDependencies> {
	loadPipelineEnvFile();
	const workspaceRoot = resolveWorkspaceRoot();
	const repository = await createPipelineRuntimeRepository({
		disableRevalidation: options.skipRevalidation,
	});

	return {
		// ── run command ──────────────────────────────────────────────────
		async runCommand(options) {
			if (options.sourceItems) {
				return handleSourceItemsRun(options, repository);
			}

			const logger = new PipelineLogger();
			const catalogEntries = await loadCatalogEntries(workspaceRoot);

			const selectedEntries = options.file
				? [
						{
							title: path.parse(options.file).name,
							artist: '',
							source_url: path.resolve(options.file),
							output_path: path.resolve(options.file),
							comments: [],
						},
					]
				: catalogEntries.filter((entry) => !options.source || resolveSourceSite(entry.source_url) === options.source);

			let filteredEntries = selectedEntries;
			if (options.status) {
				const matchingSourceUrls = new Set(await repository.getCatalogSourceUrlsByStatus(options.status));
				filteredEntries = filteredEntries.filter((entry) => matchingSourceUrls.has(entry.source_url));
			}

			const entriesToProcess = filteredEntries.slice(0, options.limit);

			const results = await mapWithConcurrency(entriesToProcess, options.concurrency, async (entry) => {
				const fileBytes = await fs.readFile(entry.output_path);
				const evaluation = await evaluatePipelineStages(
					{
						rawTitle: entry.title,
						rawArtist: entry.artist,
						file: fileBytes,
					},
					repository,
					{ allowArtistCreation: false },
				);

				if (!evaluation.ok) {
					logger.log({
						status: 'rejected',
						source_url: entry.source_url,
						rejection_reason: evaluation.rejectionReason,
						quality_reasons: [],
					});

					return {
						sourceUrl: entry.source_url,
						outcome: 'rejected',
						preview: evaluation,
					};
				}

				const previewOutcome = determinePublicationOutcome(
					evaluation.qualityAssessment.score,
					evaluation.normalized.confidenceScore,
				);
				const logStatus = options.dryRun
					? 'dry_run'
					: previewOutcome === 'needs_review'
						? 'needs_review'
						: previewOutcome;

				logger.log({
					status: logStatus,
					source_url: entry.source_url,
					quality_score: evaluation.qualityAssessment.score,
					rejection_reason: previewOutcome === 'rejected' ? 'low_quality' : undefined,
					quality_reasons: evaluation.qualityAssessment.reasons,
				});

				if (options.dryRun) {
					return {
						sourceUrl: entry.source_url,
						outcome: 'dry_run',
						preview: evaluation,
					};
				}

				const processed = await processPipelineJob(
					{
						sourceUrl: entry.source_url,
						sourceSite: resolveSourceSite(entry.source_url),
						rawTitle: entry.title,
						rawArtist: entry.artist,
						tips: entry.comments,
						file: fileBytes,
						dryRun: false,
					},
					repository,
				);

				return {
					sourceUrl: entry.source_url,
					outcome: processed.outcome,
					preview: evaluation,
					processed,
				};
			});

			if (options.file && results[0]?.preview?.ok) {
				const preview = results[0].preview;
				return {
					preview: {
						sourceUrl: results[0].sourceUrl,
						title: preview.normalized.title,
						artist: preview.normalized.artist,
						sheetData: preview.conversion.sheetData,
						metadata: {
							confidenceScore: preview.normalized.confidenceScore,
							confidenceBand: preview.normalized.confidenceBand,
							genre: preview.enrichment.genre,
							difficulty: preview.enrichment.difficulty,
							slug: preview.enrichment.slug,
						},
						quality: preview.qualityAssessment,
						dedup: preview.dedupDecision,
						publicationOutcome: determinePublicationOutcome(
							preview.qualityAssessment.score,
							preview.normalized.confidenceScore,
						),
					},
					summary: logger.summarize(),
				};
			}

			return {
				entries: logger.getEntries(),
				summary: logger.summarize(),
			};
		},

		// ── import command ────────────────────────────────────────────────
		async importCommand(options) {
			const storage = createStorageClientFromEnv();
			const bucket = process.env.STORAGE_BUCKET ?? 'midi-files';

			// 1. Read and parse export JSON
			const rawExport = await fs.readFile(options.exportFile, 'utf8');
			const exportJson = JSON.parse(rawExport) as {
				timing_config?: unknown;
				records?: RawScraperRecord[];
			};
			const exportRecords = exportJson.records ?? [];
			const adapted = adaptScraperExportRecords(exportRecords);
			const records = adapted.records;

			const limitedRecords = options.limit
				? records.slice(0, options.limit)
				: records;

			// 2. Scan download directory
			const scanResult = await scanDownloadDirectory(options.downloadDir);

			// 3. Run time-window matching
			const timingConfig = resolveImportTimingConfig(exportJson, options);
			const { matches, unmatchedFiles } = matchFilesToRecords(
				scanResult.files,
				limitedRecords,
				timingConfig,
			);

			// 4. Create import_run (unless dry-run)
			let importRunId: string | null = null;
			if (!options.dryRun) {
				const run = await createImportRun(repository.db, {
					source: 'midi-scraper-extension',
					downloadDir: options.downloadDir,
					config: {
						timingConfig,
						exportFile: options.exportFile,
						limit: options.limit,
					},
				});
				importRunId = run.id;
			}

			// 5. Process matches
			let filesUploaded = 0;
			let rowsCreated = 0;
			const uploadByPath = new Map<string, ImportUploadDetail>();
			const catalogByPath = new Map<string, ImportCatalogDetail>();
			const matchedFiles = new Set<string>();

			const storageClientForUpload: StorageClient = storage;

			for (const match of matches) {
				matchedFiles.add(match.file.absolutePath);
				if (!options.dryRun) {
					const normalizedVariant = match.variant as NormalizedImportVariant;
					// 5a. Upload matched file to storage
					const uploadResult = await uploadAsset(
						{ filePath: match.file.absolutePath },
						{
							storage: storageClientForUpload,
							findAssetBySha256: repository.findAssetBySha256,
							insertAsset: repository.insertAsset,
							bucket,
						},
					);
					filesUploaded += uploadResult.reused ? 0 : 1;
					uploadByPath.set(match.file.absolutePath, {
						performed: true,
						reused: uploadResult.reused,
						assetId: uploadResult.assetId,
						publicUrl: uploadResult.publicUrl,
						byteSize: uploadResult.byteSize,
					});

					// 5b. Write catalog (work + arrangement + pipeline_job)
					const catalogResult = await writeCatalog(normalizedVariant, {
						work: createWorkDeps(repository.db),
						arrangement: createArrangementDeps(repository.db),
						pipelineJob: createPipelineJobDeps(repository.db),
						sheetAssetId: uploadResult.assetId,
					});
					await updateAssetArrangement(repository.db, uploadResult.assetId, catalogResult.arrangementId);
					rowsCreated += 1;
					catalogByPath.set(match.file.absolutePath, {
						performed: true,
						arrangementId: catalogResult.arrangementId,
						arrangementNew: catalogResult.arrangementNew,
						pipelineJobId: catalogResult.pipelineJobId,
						pipelineJobNew: catalogResult.pipelineJobNew,
					});

					// 5c. Create import_event for audit
					await createImportEvent(repository.db, importRunId!, {
						arrangementId: catalogResult.arrangementId,
						localFilePath: match.file.absolutePath,
						fileBirthtime: match.file.birthtime,
						fileCtime: match.file.ctime,
						fileMtime: match.file.mtime,
						fileName: match.file.filename,
						fileSha256: uploadResult.sha256,
						matchMethod: match.matchMethod,
						matchConfidence: match.confidence === 'high' ? 1 : match.confidence === 'medium' ? 0.5 : 0,
						matchReason: {
							deltaSeconds: match.timeDeltaSeconds,
							windowConfig: timingConfig as unknown as Record<string, unknown>,
						},
						confidenceBand: match.confidence,
						structuralValidationFailed: match.reviewStatus === 'needs_review',
					});
				} else {
					uploadByPath.set(match.file.absolutePath, {
						performed: false,
						reused: false,
						assetId: null,
						publicUrl: null,
						byteSize: null,
					});
					catalogByPath.set(match.file.absolutePath, {
						performed: false,
						arrangementId: null,
						arrangementNew: false,
						pipelineJobId: null,
						pipelineJobNew: false,
					});
				}
			}

			if (!options.dryRun && importRunId) {
				for (const file of unmatchedFiles) {
					await createImportEvent(repository.db, importRunId, {
						arrangementId: null,
						localFilePath: file.absolutePath,
						fileBirthtime: file.birthtime,
						fileCtime: file.ctime,
						fileMtime: file.mtime,
						fileName: file.filename,
						matchMethod: null,
						matchConfidence: 0,
						matchReason: {
							windowConfig: timingConfig as unknown as Record<string, unknown>,
							reason: 'no matching export variant found within configured window',
						},
						confidenceBand: 'low',
						structuralValidationFailed: true,
					});
				}
			}

			// 6. Finalize import_run (unless dry-run)
			if (importRunId && !options.dryRun) {
				await updateImportRun(repository.db, importRunId, 'completed');
			}

			const detailed = buildImportMatchDetails({
				files: scanResult.files,
				records: limitedRecords,
				matches: matches.map((match) => ({
					file: match.file,
					variant: match.variant as NormalizedImportVariant,
					matchMethod: match.matchMethod,
					confidence: match.confidence,
					timeDeltaSeconds: match.timeDeltaSeconds,
					matchReason: match.matchReason,
					reviewStatus: match.reviewStatus,
				})),
				uploadByPath,
				catalogByPath,
				unmatchedFiles,
				timingConfig,
			});

			return {
				filesScanned: scanResult.files.length,
				filesMatched: matches.length,
				filesUploaded,
				rowsCreated,
				dryRun: options.dryRun,
				importRunId,
				diagnostics: adapted.diagnostics,
				matchedFileDetails: detailed.matchedFileDetails,
				unmatchedLocalFileDetails: detailed.unmatchedLocalFileDetails,
				unmatchedExportVariantDetails: detailed.unmatchedExportVariantDetails,
			};
		},

		async statsCommand() {
			return repository.getStats();
		},
		async seedCommand() {
			return repository.seedReferenceData();
		},
		async dispose() {
			await repository.close();
		},
		stdout(message) {
			process.stdout.write(`${message}\n`);
		},
		stderr(message) {
			process.stderr.write(`${message}\n`);
		},
	};
}

// ── Source-items run handler ──────────────────────────────────────────────────

/**
 * Coerce a raw DB string to SourceDifficultyLabel.
 * Keep this in sync with provider-adapter.ts source difficulty normalization.
 * Unknown / null values become null so callers can omit unrecognised labels
 * without risking silent type widening.
 */
export function asSourceDifficultyLabel(v: string | null): SourceDifficultyLabel | null {
	const label = v?.trim().toLowerCase();
	if (label === 'beginner') return 'Beginner';
	if (label === 'intermediate') return 'Intermediate';
	if (label === 'advanced') return 'Advanced';
	return null;
}

async function handleSourceItemsRun(
	options: RunCommandOptions,
	repository: Awaited<ReturnType<typeof createPipelineRuntimeRepository>>,
): Promise<unknown> {
	const logger = new PipelineLogger();
	const inventory = await repository.getSourceItemInventory({ source: options.source });
	if (options.forceGenerate) {
		const forceSource = await repository.getSourceItemForForceGeneration({
			arrangementId: options.arrangementId!,
			source: options.source,
		});

		if (!forceSource) {
			throw new Error(`No source item found for arrangement-id: ${options.arrangementId}`);
		}

		const fileBuffer = await downloadFromStorage(forceSource.bucket, forceSource.objectPath);

		try {
			const processed = await processPipelineJob(
				{
					forceGeneration: {
						jobId: forceSource.id,
						forcedAt: new Date(),
						forceReason: options.reason!.trim(),
						forceContext: {
							arrangementId: options.arrangementId,
							sourceUrl: forceSource.sourceUrl,
							sourceSite: forceSource.sourceSite,
							operatorPublish: options.publish,
						},
						publish: Boolean(options.publish),
					},
					sourceUrl: forceSource.sourceUrl,
					sourceSite: forceSource.sourceSite ?? resolveSourceSite(forceSource.sourceUrl),
					rawTitle: forceSource.rawTitle ?? path.parse(forceSource.objectPath).name,
					rawArtist: '',
					tips: [],
					file: new Uint8Array(fileBuffer),
					dryRun: false,
					workId: forceSource.workId ?? null,
					arrangementId: forceSource.arrangementId ?? null,
					sourceDifficultyLabel: asSourceDifficultyLabel(forceSource.sourceDifficultyLabel),
					conversionLevel: 'Adept',
				},
				repository,
			);

			const needsReview = processed.outcome === 'needs_review';
			process.stderr.write(
				`[force] arrangementId=${options.arrangementId} reason="${options.reason!.trim()}" publish=${Boolean(options.publish)} outcome=${processed.outcome} needsReview=${needsReview} sourceUrl=${forceSource.sourceUrl}\n`,
			);
			logger.log({
				status: processed.outcome,
				source_url: forceSource.sourceUrl,
				needs_review: needsReview,
				details: {
					mode: 'force',
					arrangementId: options.arrangementId,
					reason: options.reason!.trim(),
					publish: Boolean(options.publish),
					outcome: processed.outcome,
					sourceState: 'untouched',
					sheetId: processed.sheetId ?? null,
				},
			});

			return {
				inventory,
				entries: logger.getEntries(),
				summary: logger.summarize(),
				forceGeneration: {
					arrangementId: options.arrangementId,
					forced: true,
					outcome: processed.outcome,
					needsReview,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown force generation error.';
			process.stderr.write(
				`[force-failed] arrangementId=${options.arrangementId} reason="${options.reason!.trim()}" message="${message}" sourceUrl=${forceSource.sourceUrl}\n`,
			);
			logger.log({
				status: 'failed',
				source_url: forceSource.sourceUrl,
				quality_reasons: [],
				details: {
					mode: 'force',
					arrangementId: options.arrangementId,
					reason: options.reason!.trim(),
					publish: Boolean(options.publish),
					failureMessage: message,
					sourceState: 'untouched',
				},
			});
			throw error;
		}
	}
	process.stderr.write(`[inventory] queued=${inventory.queued} running=${inventory.running} failed=${inventory.failed} rejected=${inventory.rejected} published=${inventory.published} stranded=${inventory.stranded} stale=${inventory.stale}\n`);
	for (const warning of inventory.warnings) {
		process.stderr.write(`${formatInventoryWarning(warning)}\n`);
	}
	if (inventory.warnings.length > 0) {
		logger.log({
			status: 'failed',
			source_url: inventory.warnings[0].sourceUrl,
			quality_reasons: [],
			details: { warningCount: inventory.warnings.length },
		});
	}

	if (options.retryFailed) {
		const recovery = await repository.requeueFailedJobs({ source: options.source });
		for (const sourceUrl of recovery.sourceUrls) {
			process.stderr.write(`[recovery] mode=retry-failed sourceUrl=${sourceUrl}\n`);
		}
		logger.log({
			status: 'failed',
			source_url: recovery.sourceUrls[0] ?? 'unknown',
			quality_reasons: [],
			details: { mode: 'retry-failed', requeued: recovery.requeued },
		});
		return {
			inventory,
			recovery,
			entries: logger.getEntries(),
			summary: logger.summarize(),
		};
	}

	if (options.requeueStranded) {
		const recovery = await repository.requeueStrandedJobs({ source: options.source });
		for (const sourceUrl of recovery.sourceUrls) {
			process.stderr.write(`[recovery] mode=requeue-stranded sourceUrl=${sourceUrl}\n`);
		}
		logger.log({
			status: 'failed',
			source_url: recovery.sourceUrls[0] ?? 'unknown',
			quality_reasons: [],
			details: { mode: 'requeue-stranded', requeued: recovery.requeued },
		});
		return {
			inventory,
			recovery,
			entries: logger.getEntries(),
			summary: logger.summarize(),
		};
	}

	// Query pending pipeline_jobs with their asset info
	const jobs = await repository.listJobsWithAssets({
		source: options.source,
		status: options.status ?? 'pending',
		limit: options.limit,
	});

	if (jobs.length === 0) {
		return {
			inventory,
			entries: [],
			summary: logger.summarize(),
			warnings: inventory.warnings,
			note: inventory.queued === 0
				? 'No queued source items found. Inventory and stranded warnings shown below.'
				: 'No queued source items found.',
		};
	}

	// Create temp dir for downloads
	const tempDir = await mkdtemp(path.join(tmpdir(), 'pipeline-src-items-'));
	let cleanup = true;

	try {
		const results = await mapWithConcurrency(jobs, options.concurrency, async (job) => {
			// Download asset from Supabase Storage
			const fileBuffer = await downloadFromStorage(job.bucket, job.objectPath);
			const fileBytes = new Uint8Array(fileBuffer);
			const sourceUrl = job.sourceUrl;
			const title = job.rawTitle ?? path.parse(job.objectPath).name;

			const evaluation = await evaluatePipelineStages(
				{
					rawTitle: title,
					rawArtist: '',
					file: fileBytes,
				},
				repository,
				{ allowArtistCreation: false },
			);

			if (!evaluation.ok) {
				logger.log({
					status: 'rejected',
					source_url: sourceUrl,
					rejection_reason: evaluation.rejectionReason,
					quality_reasons: [],
				});

				return { sourceUrl, outcome: 'rejected', preview: evaluation };
			}

			const previewOutcome = determinePublicationOutcome(
				evaluation.qualityAssessment.score,
				evaluation.normalized.confidenceScore,
			);
			const logStatus = options.dryRun
				? 'dry_run'
				: previewOutcome === 'needs_review'
					? 'needs_review'
					: previewOutcome;

			logger.log({
				status: logStatus,
				source_url: sourceUrl,
				quality_score: evaluation.qualityAssessment.score,
				rejection_reason: previewOutcome === 'rejected' ? 'low_quality' : undefined,
				quality_reasons: evaluation.qualityAssessment.reasons,
			});

			if (options.dryRun) {
				return { sourceUrl, outcome: 'dry_run', preview: evaluation };
			}

			const processed = await processPipelineJob(
				{
					sourceUrl,
					sourceSite: job.sourceSite ?? resolveSourceSite(sourceUrl),
					rawTitle: title,
					rawArtist: '',
					tips: [],
					file: fileBytes,
					dryRun: false,
					// Import provenance — resolved from the arrangement row via listJobsWithAssets.
					workId: job.workId ?? null,
					arrangementId: job.arrangementId ?? null,
					sourceDifficultyLabel: asSourceDifficultyLabel(job.sourceDifficultyLabel),
					conversionLevel: 'Adept',
				},
				repository,
			);

			return {
				sourceUrl,
				outcome: processed.outcome,
				preview: evaluation,
				processed,
			};
		});

		return {
			inventory,
			entries: logger.getEntries(),
			summary: logger.summarize(),
			sourceItemCount: jobs.length,
			warnings: inventory.warnings,
			results,
		};
	} finally {
		if (cleanup) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {
				/* ignore cleanup failures */
			});
		}
	}
}

// ── DB dep helpers for writeCatalog ──────────────────────────────────────────

function createWorkDeps(db: ZenDatabase) {
	return {
		findByCanonicalTitleAndArtist: async (title: string, artist: string) => {
			const [row] = await db
				.select({ id: work.id, slug: work.slug, canonicalTitle: work.canonicalTitle, canonicalArtistName: work.canonicalArtistName })
				.from(work)
				.where(and(eq(work.canonicalTitle, title), eq(work.canonicalArtistName, artist)))
				.limit(1);
			return row ?? null;
		},
		findBySlug: async (slug: string) => {
			const [row] = await db
				.select({ id: work.id })
				.from(work)
				.where(eq(work.slug, slug))
				.limit(1);
			return row ?? null;
		},
		insertWork: async (input: {
			slug: string;
			canonicalTitle: string;
			canonicalArtistName: string | null;
			artistUrl: string | null;
			songUrl: string | null;
		}) => {
			const [inserted] = await db
				.insert(work)
				.values({
					slug: input.slug,
					canonicalTitle: input.canonicalTitle,
					canonicalArtistName: input.canonicalArtistName,
					artistUrl: input.artistUrl,
					songUrl: input.songUrl,
				})
				.returning({ id: work.id });
			return inserted;
		},
	};
}

function createArrangementDeps(db: ZenDatabase) {
	return {
		findByProviderItem: async (provider: string, providerItemId: string) => {
			const [row] = await db
				.select({
					id: arrangement.id,
					provider: arrangement.provider,
					providerItemId: arrangement.providerItemId,
					sourceViewCount: arrangement.sourceViewCount,
					sourceLikeCount: arrangement.sourceLikeCount,
					sourceCommentCount: arrangement.sourceCommentCount,
					sourceRatingScore: arrangement.sourceRatingScore,
					sourceRatingCount: arrangement.sourceRatingCount,
				})
				.from(arrangement)
				.where(and(eq(arrangement.provider, provider), eq(arrangement.providerItemId, providerItemId)))
				.limit(1);
			return row as {
				id: string;
				provider: string;
				providerItemId: string;
				sourceViewCount: number | null;
				sourceLikeCount: number | null;
				sourceCommentCount: number | null;
				sourceRatingScore: number | null;
				sourceRatingCount: number | null;
			} | null;
		},
		insertArrangement: async (input: Record<string, unknown>) => {
			const [inserted] = await db
				.insert(arrangement)
				.values(input as never)
				.returning({ id: arrangement.id });
			return inserted;
		},
		updateArrangement: async (id: string, input: Record<string, unknown>) => {
			await db
				.update(arrangement)
				.set(input as never)
				.where(eq(arrangement.id, id));
		},
	};
}

function createPipelineJobDeps(db: ZenDatabase) {
	return {
		findBySourceKey: async (sourceKey: string) => {
			const [row] = await db
				.select({ id: pipelineJob.id, status: pipelineJob.status, state: pipelineJob.state, phase: pipelineJob.phase })
				.from(pipelineJob)
				.where(eq(pipelineJob.sourceKey, sourceKey))
				.limit(1);
			return row ?? null;
		},
		insertPipelineJob: async (input: Record<string, unknown>) => {
			const [inserted] = await db
				.insert(pipelineJob)
				.values(input as never)
				.returning({ id: pipelineJob.id });
			return inserted;
		},
		updatePipelineJob: async (id: string, input: Record<string, unknown>) => {
			await db
				.update(pipelineJob)
				.set(input as never)
				.where(eq(pipelineJob.id, id));
		},
	};
}

async function updateAssetArrangement(
	db: ZenDatabase,
	assetId: string,
	arrangementId: string,
): Promise<void> {
	await db
		.update(sheetAsset)
		.set({ arrangementId })
		.where(eq(sheetAsset.id, assetId));
}

// ── Seed dependencies factory ────────────────────────────────────────────────

async function createSeedDependencies(): Promise<CliDependencies> {
	loadPipelineEnvFile();
	const repository = await createPipelineRuntimeRepository({ allowMissingReferenceData: true });

	return {
		async runCommand() {
			throw new Error('Run command dependencies are not available for seed.');
		},
		async importCommand() {
			throw new Error('Import command dependencies are not available for seed.');
		},
		async statsCommand() {
			throw new Error('Stats command dependencies are not available for seed.');
		},
		async seedCommand() {
			return repository.seedReferenceData();
		},
		async dispose() {
			await repository.close();
		},
		stdout(message) {
			process.stdout.write(`${message}\n`);
		},
		stderr(message) {
			process.stderr.write(`${message}\n`);
		},
	};
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export async function runCli(argv = process.argv.slice(2), dependencies?: CliDependencies): Promise<number> {
	const deps = dependencies
		?? (await (argv[0] === 'seed'
			? createSeedDependencies()
			: createDefaultDependencies({ skipRevalidation: argv.includes('--skip-revalidation') })));
	const program = new Command();
	let exitCode = 0;

	program.name('pipeline').exitOverride();

	program
		.command('run')
		.option('--source <source>')
		.option('--limit <limit>', 'Max files to process in this run', '100')
		.option('--file <file>')
		.option('--dry-run', 'Process without DB writes', false)
		.option('--skip-revalidation', 'Skip landing-page ISR revalidation after publish', false)
		.option('--status <status>')
		.option('--concurrency <concurrency>', 'Parallel worker count', '5')
		.option('--source-items', 'Process pending pipeline_jobs from DB instead of catalog.json', false)
		.option('--force-generate', 'Force a sheet generation from a source item', false)
		.option('--arrangement-id <id>', 'Arrangement id to force-generate from')
		.option('--reason <text>', 'Reason for force generation')
		.option('--publish', 'Publish forced output immediately', false)
		.option('--retry-failed', 'Requeue failed pipeline jobs before processing source items', false)
		.option('--requeue-stranded', 'Requeue stranded pipeline jobs before processing source items', false)
		.action(async (rawOptions) => {
			const options: RunCommandOptions = {
				source: rawOptions.source,
				limit: Number(rawOptions.limit ?? 100),
				file: rawOptions.file,
				dryRun: Boolean(rawOptions.dryRun),
				skipRevalidation: Boolean(rawOptions.skipRevalidation),
				status: rawOptions.status,
				concurrency: Number(rawOptions.concurrency ?? 5),
				sourceItems: Boolean(rawOptions.sourceItems || rawOptions.retryFailed || rawOptions.requeueStranded),
				forceGenerate: Boolean(rawOptions.forceGenerate),
				arrangementId: rawOptions.arrangementId,
				reason: rawOptions.reason,
				publish: Boolean(rawOptions.publish),
				retryFailed: Boolean(rawOptions.retryFailed),
				requeueStranded: Boolean(rawOptions.requeueStranded),
			};

			if (options.file && options.source) {
				throw new Error('--file cannot be combined with --source.');
			}

			if (options.file && options.status) {
				throw new Error('--file cannot be combined with --status.');
			}

			if (options.file && options.sourceItems) {
				throw new Error('--file cannot be combined with --source-items.');
			}

			if (options.forceGenerate && !options.sourceItems) {
				throw new Error('--force-generate requires --source-items.');
			}

			if (options.forceGenerate && !options.arrangementId) {
				throw new Error('--arrangement-id is required with --force-generate.');
			}

			if (options.forceGenerate && !options.reason?.trim()) {
				throw new Error('--reason must be a non-empty string when using --force-generate.');
			}

			if (options.status && !VALID_STATUS_FILTERS.includes(options.status as (typeof VALID_STATUS_FILTERS)[number])) {
				throw new Error(`--status must be one of: ${VALID_STATUS_FILTERS.join(', ')}.`);
			}

			if (options.limit <= 0 || Number.isNaN(options.limit)) {
				throw new Error('--limit must be a positive number.');
			}

			if (options.concurrency <= 0 || Number.isNaN(options.concurrency)) {
				throw new Error('--concurrency must be a positive number.');
			}

			if (options.retryFailed && options.requeueStranded) {
				throw new Error('--retry-failed cannot be combined with --requeue-stranded.');
			}

			const result = await deps.runCommand(options);
			deps.stdout(JSON.stringify(result, null, 2));
		});

	program
		.command('import')
		.option('--export-file <path>', `Path to scraper-export.json from extension (default: ${DEFAULT_IMPORT_EXPORT_FILE})`)
		.option('--download-dir <path>', `Path to OS download directory with .mid files (default: ${DEFAULT_IMPORT_DOWNLOAD_DIR})`)
		.option('--timing-x <seconds>', 'Override click-to-download delay in seconds')
		.option('--timing-y <seconds>', 'Override inter-variant interval in seconds')
		.option('--timing-z <seconds>', 'Override inter-work interval in seconds')
		.option('--matching-window <seconds>', 'Override maximum file/export timestamp delta allowed for matching')
		.option('--limit <n>', 'Maximum records to process')
		.option('--dry-run', 'Run all stages but skip DB writes and uploads', false)
		.action(async (rawOptions) => {
			const exportFile = path.resolve(rawOptions.exportFile ?? DEFAULT_IMPORT_EXPORT_FILE);
			const downloadDir = path.resolve(rawOptions.downloadDir ?? DEFAULT_IMPORT_DOWNLOAD_DIR);

			if (!existsSync(exportFile)) {
				throw new Error(`Export file not found: ${exportFile}`);
			}

			if (!existsSync(downloadDir)) {
				throw new Error(`Download directory not found: ${downloadDir}`);
			}

			const options: ImportCommandOptions = {
				exportFile,
				downloadDir,
				timingX: rawOptions.timingX !== undefined ? Number(rawOptions.timingX) : undefined,
				timingY: rawOptions.timingY !== undefined ? Number(rawOptions.timingY) : undefined,
				timingZ: rawOptions.timingZ !== undefined ? Number(rawOptions.timingZ) : undefined,
				maxMatchingWindowSeconds: rawOptions.matchingWindow !== undefined ? Number(rawOptions.matchingWindow) : undefined,
				limit: rawOptions.limit ? Number(rawOptions.limit) : undefined,
				dryRun: Boolean(rawOptions.dryRun),
			};

			if (options.timingX !== undefined && (options.timingX <= 0 || Number.isNaN(options.timingX))) {
				throw new Error('--timing-x must be a positive number.');
			}

			if (options.timingY !== undefined && (options.timingY <= 0 || Number.isNaN(options.timingY))) {
				throw new Error('--timing-y must be a positive number.');
			}

			if (options.timingZ !== undefined && (options.timingZ <= 0 || Number.isNaN(options.timingZ))) {
				throw new Error('--timing-z must be a positive number.');
			}

			if (
				options.maxMatchingWindowSeconds !== undefined &&
				(options.maxMatchingWindowSeconds <= 0 || Number.isNaN(options.maxMatchingWindowSeconds))
			) {
				throw new Error('--matching-window must be a positive number.');
			}

			if (options.limit !== undefined && (options.limit <= 0 || Number.isNaN(options.limit))) {
				throw new Error('--limit must be a positive number.');
			}

			const result = await deps.importCommand(options);
			const { matchedFileDetails, unmatchedLocalFileDetails, unmatchedExportVariantDetails, ...resultWithoutDetails } = result as ImportStats;
			deps.stdout(JSON.stringify({ ...resultWithoutDetails, summary: buildImportSummary(result as ImportStats) }, null, 2));
		});

	program.command('stats').action(async () => {
		const stats = await deps.statsCommand();
		deps.stdout(formatStats(stats));
	});

	program.command('seed').action(async () => {
		const result = await deps.seedCommand();
		deps.stdout(`Seeded ${result.difficulties} difficulties and ${result.genres} genres.`);
	});

	try {
		await program.parseAsync(argv, { from: 'user' });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown CLI error.';
		deps.stderr(message);
		exitCode = 1;
	}

	try {
		await deps.dispose?.();
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown CLI cleanup error.';
		deps.stderr(message);
		exitCode = 1;
	}

	return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	void runCli().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
