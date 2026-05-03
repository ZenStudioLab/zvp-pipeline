import { Command } from 'commander';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { createStorageClientFromEnv, downloadFromStorage } from './lib/storage-client.js';
import type { ImportExportRecord, TimingConfig } from './importers/types.js';
import type { MuseScoreExport } from './importers/catalog-writer.js';
import type { StorageClient } from './importers/asset-uploader.js';
import type { ZenDatabase } from '@zen/db';
import { arrangement, pipelineJob, work } from '@zen/db';

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
};

type ImportCommandOptions = {
	exportFile: string;
	downloadDir: string;
	timingX: number;
	timingY: number;
	timingZ: number;
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

/**
 * Map an export variant + record to a MuseScoreExport for writeCatalog.
 */
function mapVariantToExport(
	record: { canonical_title: string; canonical_artist?: string },
	variant: Record<string, unknown>,
	exportRecords: Array<Record<string, unknown>>,
): MuseScoreExport {
	const scoreId = Number(variant.score_id ?? 0);
	const sourceUrl = String(variant.source_url ?? variant.score_url ?? '');
	const canonicalUrl = variant.score_url ? String(variant.score_url) : null;
	const title = record.canonical_title;
	const artist = record.canonical_artist ?? '';

	// Check for additional metadata stored in the variant
	const difficultyLabel = String(variant.difficulty_label ?? '');
	const difficultyRank = variant.difficulty_rank != null ? Number(variant.difficulty_rank) : null;

	return {
		score_id: scoreId,
		source_url: sourceUrl,
		canonical_url: canonicalUrl,
		title,
		artist,
		artist_url: variant.artist_url ? String(variant.artist_url) : null,
		song_url: variant.song_url ? String(variant.song_url) : null,
		uploader_name: variant.uploader_name ? String(variant.uploader_name) : null,
		uploader_url: variant.uploader_url ? String(variant.uploader_url) : null,
		difficulty_label: difficultyLabel,
		difficulty_rank: difficultyRank,
		duration_seconds: variant.duration_seconds != null ? Number(variant.duration_seconds) : null,
		bpm: variant.bpm != null ? Number(variant.bpm) : null,
		view_count: variant.view_count != null ? Number(variant.view_count) : null,
		like_count: variant.like_count != null ? Number(variant.like_count) : null,
		comment_count: variant.comment_count != null ? Number(variant.comment_count) : null,
		rating_score: variant.rating_score != null ? Number(variant.rating_score) : null,
		rating_count: variant.rating_count != null ? Number(variant.rating_count) : null,
		pages: variant.pages ? String(variant.pages) : null,
		measures: variant.measures ? String(variant.measures) : null,
		key: variant.key ? String(variant.key) : null,
		parts: variant.parts ? String(variant.parts) : null,
		credits: variant.credits ? String(variant.credits) : null,
		uploaded_at: variant.uploaded_at ? String(variant.uploaded_at) : null,
		updated_at: variant.updated_at ? String(variant.updated_at) : null,
		license_label: variant.license_label ? String(variant.license_label) : null,
		license_url: variant.license_url ? String(variant.license_url) : null,
		privacy: variant.privacy ? String(variant.privacy) : null,
		tags: Array.isArray(variant.tags) ? variant.tags.map(String) : null,
		related_versions: variant.related_versions ?? null,
		raw_metadata: (variant.raw_metadata as Record<string, unknown>) ?? {},
		scraped_at: String(variant.scraped_at ?? new Date().toISOString()),
	};
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
				records?: Array<Record<string, unknown>>;
			};
			const exportRecords = exportJson.records ?? [];
			const records: ImportExportRecord[] = [];

			for (const raw of exportRecords) {
				const variantsRaw = (raw.variants as Array<Record<string, unknown>>) ?? [];
				records.push({
					work_order: Number(raw.work_order ?? 0),
					canonical_title: String(raw.canonical_title ?? ''),
					variants: variantsRaw.map((v) => ({
						difficulty_label: String(v.difficulty_label ?? ''),
						download_filename: v.download_filename ? String(v.download_filename) : null,
						download_started_at: v.download_started_at ? String(v.download_started_at) : null,
						score_id: v.score_id ? String(v.score_id) : undefined,
						score_url: v.score_url ? String(v.score_url) : undefined,
					})),
				});
			}

			const limitedRecords = options.limit
				? records.slice(0, options.limit)
				: records;

			// 2. Scan download directory
			const scanResult = await scanDownloadDirectory(options.downloadDir);

			// 3. Run time-window matching
			const timingConfig: TimingConfig = {
				x: options.timingX,
				y: options.timingY,
				z: options.timingZ,
			};
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

			// Build a lookup from work_order → raw record for variant-to-export mapping
			const recordByOrder = new Map<number, Record<string, unknown>>();
			for (const raw of exportRecords) {
				recordByOrder.set(Number(raw.work_order ?? 0), raw);
			}

			const storageClientForUpload: StorageClient = storage;

			for (const match of matches) {
				if (!options.dryRun) {
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

					// 5b. Write catalog (work + arrangement + pipeline_job)
					const rawRecord = recordByOrder.get(match.workOrder) ?? ({} as Record<string, unknown>);
					const rawVariants = Array.isArray(rawRecord.variants) ? (rawRecord.variants as Array<Record<string, unknown>>) : [];
					const variantIndex = rawVariants.findIndex(
						(v) => String(v.difficulty_label) === match.variant.difficulty_label,
					);
					const rawVariant: Record<string, unknown> = variantIndex >= 0
						? rawVariants[variantIndex]
						: (match.variant as unknown as Record<string, unknown>);
					const mscoreExport = mapVariantToExport(
						{
							canonical_title: match.canonicalTitle,
							canonical_artist: String(rawRecord.canonical_artist ?? ''),
						},
						rawVariant,
						exportRecords,
					);

					const catalogResult = await writeCatalog(mscoreExport, {
						work: createWorkDeps(repository.db),
						arrangement: createArrangementDeps(repository.db),
						pipelineJob: createPipelineJobDeps(repository.db),
						sheetAssetId: uploadResult.assetId,
					});
					rowsCreated += 1;

					// 5c. Create import_event for audit
					const arrangementRecord = await findArrangementByProviderItem(
						repository.db,
						'musescore',
						`musescore:${mscoreExport.score_id}`,
					);
					const pipelineJobRecord = await findPipelineJobBySourceKey(
						repository.db,
						`musescore:${mscoreExport.score_id}`,
					);

					await createImportEvent(repository.db, importRunId!, {
						arrangementId: arrangementRecord?.id ?? catalogResult.arrangementId,
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
				}
			}

			// 6. Finalize import_run (unless dry-run)
			if (importRunId && !options.dryRun) {
				await updateImportRun(repository.db, importRunId, 'completed');
			}

			return {
				filesScanned: scanResult.files.length,
				filesMatched: matches.length,
				filesUploaded,
				rowsCreated,
				dryRun: options.dryRun,
				importRunId,
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

async function handleSourceItemsRun(
	options: RunCommandOptions,
	repository: Awaited<ReturnType<typeof createPipelineRuntimeRepository>>,
): Promise<unknown> {
	const logger = new PipelineLogger();

	// Query pending pipeline_jobs with their asset info
	const jobs = await repository.listJobsWithAssets({
		source: options.source,
		status: options.status ?? 'pending',
		limit: options.limit,
	});

	if (jobs.length === 0) {
		return {
			entries: [],
			summary: logger.summarize(),
			note: 'No pending source items found.',
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
			entries: logger.getEntries(),
			summary: logger.summarize(),
			sourceItemCount: jobs.length,
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
				.where(eq(arrangement.providerItemId, providerItemId))
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
				.select({ id: pipelineJob.id, status: pipelineJob.status })
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

// ── DB helpers for import audit ──────────────────────────────────────────────

async function findArrangementByProviderItem(
	db: ZenDatabase,
	provider: string,
	providerItemId: string,
): Promise<{ id: string } | null> {
	const [row] = await db
		.select({ id: arrangement.id })
		.from(arrangement)
		.where(eq(arrangement.providerItemId, providerItemId))
		.limit(1);
	return row ?? null;
}

async function findPipelineJobBySourceKey(
	db: ZenDatabase,
	sourceKey: string,
): Promise<{ id: string; status: string } | null> {
	const [row] = await db
		.select({ id: pipelineJob.id, status: pipelineJob.status })
		.from(pipelineJob)
		.where(eq(pipelineJob.sourceKey, sourceKey))
		.limit(1);
	return row ?? null;
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
		.action(async (rawOptions) => {
			const options: RunCommandOptions = {
				source: rawOptions.source,
				limit: Number(rawOptions.limit ?? 100),
				file: rawOptions.file,
				dryRun: Boolean(rawOptions.dryRun),
				skipRevalidation: Boolean(rawOptions.skipRevalidation),
				status: rawOptions.status,
				concurrency: Number(rawOptions.concurrency ?? 5),
				sourceItems: Boolean(rawOptions.sourceItems),
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

			if (options.status && !VALID_STATUS_FILTERS.includes(options.status as (typeof VALID_STATUS_FILTERS)[number])) {
				throw new Error(`--status must be one of: ${VALID_STATUS_FILTERS.join(', ')}.`);
			}

			if (options.limit <= 0 || Number.isNaN(options.limit)) {
				throw new Error('--limit must be a positive number.');
			}

			if (options.concurrency <= 0 || Number.isNaN(options.concurrency)) {
				throw new Error('--concurrency must be a positive number.');
			}

			const result = await deps.runCommand(options);
			deps.stdout(JSON.stringify(result, null, 2));
		});

	program
		.command('import')
		.requiredOption('--export-file <path>', 'Path to scraper-export.json from extension')
		.requiredOption('--download-dir <path>', 'Path to OS download directory with .mid files')
		.option('--timing-x <seconds>', 'Click-to-download delay in seconds', '8')
		.option('--timing-y <seconds>', 'Inter-work interval in seconds', '20')
		.option('--timing-z <seconds>', 'Inter-variant interval in seconds', '10')
		.option('--limit <n>', 'Maximum records to process')
		.option('--dry-run', 'Run all stages but skip DB writes and uploads', false)
		.action(async (rawOptions) => {
			if (!existsSync(rawOptions.exportFile)) {
				throw new Error(`Export file not found: ${rawOptions.exportFile}`);
			}

			if (!existsSync(rawOptions.downloadDir)) {
				throw new Error(`Download directory not found: ${rawOptions.downloadDir}`);
			}

			const options: ImportCommandOptions = {
				exportFile: path.resolve(rawOptions.exportFile),
				downloadDir: path.resolve(rawOptions.downloadDir),
				timingX: Number(rawOptions.timingX),
				timingY: Number(rawOptions.timingY),
				timingZ: Number(rawOptions.timingZ),
				limit: rawOptions.limit ? Number(rawOptions.limit) : undefined,
				dryRun: Boolean(rawOptions.dryRun),
			};

			if (options.timingX <= 0 || Number.isNaN(options.timingX)) {
				throw new Error('--timing-x must be a positive number.');
			}

			if (options.timingY <= 0 || Number.isNaN(options.timingY)) {
				throw new Error('--timing-y must be a positive number.');
			}

			if (options.timingZ <= 0 || Number.isNaN(options.timingZ)) {
				throw new Error('--timing-z must be a positive number.');
			}

			if (options.limit !== undefined && (options.limit <= 0 || Number.isNaN(options.limit))) {
				throw new Error('--limit must be a positive number.');
			}

			const result = await deps.importCommand(options);
			deps.stdout(JSON.stringify(result, null, 2));
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
