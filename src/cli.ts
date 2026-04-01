import { Command } from 'commander';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { loadPipelineEnvFile } from './env.js';
import { createPipelineRuntimeRepository } from './lib/runtime-repository.js';
import { PipelineLogger } from './lib/logger.js';
import { processPipelineJob } from './lib/process-job.js';
import { evaluatePipelineStages } from './lib/run-stages.js';
import { determinePublicationOutcome } from './stages/publisher.js';

type RunCommandOptions = {
	source?: string;
	limit: number;
	file?: string;
	dryRun: boolean;
	status?: string;
	concurrency: number;
};

type PipelineStats = Awaited<ReturnType<Awaited<ReturnType<typeof createPipelineRuntimeRepository>>['getStats']>>;

type CliDependencies = {
	runCommand(options: RunCommandOptions): Promise<unknown>;
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

const COMMENT_MAX_LENGTH = 500;
const VALID_STATUS_FILTERS = ['pending', 'converting', 'scoring', 'dedup', 'published', 'needs_review', 'rejected', 'failed'] as const;

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

async function createDefaultDependencies(): Promise<CliDependencies> {
	loadPipelineEnvFile();
	const workspaceRoot = resolveWorkspaceRoot();
	const repository = await createPipelineRuntimeRepository();

	return {
		async runCommand(options) {
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

export async function runCli(argv = process.argv.slice(2), dependencies?: CliDependencies): Promise<number> {
	const deps = dependencies ?? (await createDefaultDependencies());
	const program = new Command();
	let exitCode = 0;

	program.name('pipeline').exitOverride();

	program
		.command('run')
		.option('--source <source>')
		.option('--limit <limit>', 'Max files to process in this run', '100')
		.option('--file <file>')
		.option('--dry-run', 'Process without DB writes', false)
		.option('--status <status>')
		.option('--concurrency <concurrency>', 'Parallel worker count', '5')
		.action(async (rawOptions) => {
			const options: RunCommandOptions = {
				source: rawOptions.source,
				limit: Number(rawOptions.limit ?? 100),
				file: rawOptions.file,
				dryRun: Boolean(rawOptions.dryRun),
				status: rawOptions.status,
				concurrency: Number(rawOptions.concurrency ?? 5),
			};

			if (options.file && options.source) {
				throw new Error('--file cannot be combined with --source.');
			}

			if (options.file && options.status) {
				throw new Error('--file cannot be combined with --status.');
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