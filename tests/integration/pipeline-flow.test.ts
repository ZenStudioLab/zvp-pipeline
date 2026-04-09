import TonejsMidi from "@tonejs/midi";
import { describe, expect, it, vi } from "vitest";

import { processPipelineJob } from "../../src/lib/process-job";
import type {
  ArtistRecord,
  DifficultyRecord,
  FingerprintRecord,
  GenreRecord,
} from "../../src/stages/types";

const { Midi } = TonejsMidi;

vi.mock("@zen/midi-to-vp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zen/midi-to-vp")>();
  return {
    ...actual,
    scoreConversionQuality: vi.fn(actual.scoreConversionQuality),
  };
});

import { scoreConversionQuality } from "@zen/midi-to-vp";

function createPipelineMidi(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);

  const track = midi.addTrack();
  track.channel = 0;
  track.addNote({ midi: 60, time: 0, duration: 0.25, velocity: 0.8 });
  track.addNote({ midi: 64, time: 0.25, duration: 0.25, velocity: 0.82 });
  track.addNote({ midi: 67, time: 0.5, duration: 0.25, velocity: 0.84 });

  return new Uint8Array(midi.toArray());
}

class InMemoryPipelineRepository {
  public readonly genres: GenreRecord[] = [
    { id: "genre_soundtrack", slug: "soundtrack", name: "Soundtrack" },
  ];
  public readonly difficulties: DifficultyRecord[] = [
    {
      id: "difficulty_beginner",
      slug: "beginner",
      label: "Beginner",
      level: 1,
    },
    {
      id: "difficulty_intermediate",
      slug: "intermediate",
      label: "Intermediate",
      level: 2,
    },
    {
      id: "difficulty_advanced",
      slug: "advanced",
      label: "Advanced",
      level: 3,
    },
    { id: "difficulty_expert", slug: "expert", label: "Expert", level: 4 },
  ];

  public readonly statusTransitions: string[] = [];
  public readonly sheets: Array<Record<string, unknown>> = [];
  public readonly revalidated: string[][] = [];
  public readonly jobStatuses: Array<Record<string, unknown>> = [];

  private readonly jobs = new Map<
    string,
    { status: string; sheetId: string | null }
  >();
  private readonly artists = new Map<string, ArtistRecord>();
  private readonly fingerprints = new Map<string, FingerprintRecord>();

  async getJobBySourceUrl(
    sourceUrl: string,
  ): Promise<{ status: string; sheetId: string | null } | null> {
    return this.jobs.get(sourceUrl) ?? null;
  }

  async saveJobStatus(event: {
    sourceUrl: string;
    status: string;
    sheetId?: string | null;
    qualityScore?: number;
    rubricVersion?: string;
    qualityReasons?: string[];
    rejectionReason?: string;
  }): Promise<void> {
    this.statusTransitions.push(event.status);
    this.jobStatuses.push(event);
    this.jobs.set(event.sourceUrl, {
      status: event.status,
      sheetId: event.sheetId ?? null,
    });
  }

  async getExistingArtistNames(): Promise<string[]> {
    return [...this.artists.values()].map((artist) => artist.name);
  }

  async findArtistByNormalizedName(
    normalizedName: string,
  ): Promise<ArtistRecord | null> {
    return this.artists.get(normalizedName) ?? null;
  }

  async createArtist(input: {
    name: string;
    slug: string;
    normalizedName: string;
  }): Promise<ArtistRecord> {
    const artist = {
      id: `artist_${this.artists.size + 1}`,
      slug: input.slug,
      name: input.name,
    };
    this.artists.set(input.normalizedName, artist);
    return artist;
  }

  async findFingerprintByKey(
    normalizedKey: string,
  ): Promise<FingerprintRecord | null> {
    return this.fingerprints.get(normalizedKey) ?? null;
  }

  async insertSheet(
    sheet: Record<string, unknown>,
  ): Promise<{ id: string; slug: string }> {
    const inserted: Record<string, unknown> = {
      id: `sheet_${this.sheets.length + 1}`,
      ...sheet,
    };
    this.sheets.push(inserted);
    return { id: String(inserted.id), slug: String(inserted["slug"]) };
  }

  async updateFingerprint(update: {
    normalizedKey: string;
    canonicalSheetId: string;
    versionCount: number;
  }): Promise<void> {
    this.fingerprints.set(update.normalizedKey, {
      normalizedKey: update.normalizedKey,
      canonicalSheetId: update.canonicalSheetId,
      canonicalQualityScore: 0.82,
      versionCount: update.versionCount,
    });
  }

  async revalidatePaths(paths: string[]): Promise<void> {
    this.revalidated.push(paths);
  }
}

describe("processPipelineJob", () => {
  it("runs the pipeline end-to-end and remains idempotent on rerun", async () => {
    const repository = new InMemoryPipelineRepository();
    const input = {
      sourceUrl: "https://example.com/interstellar.mid",
      sourceSite: "freemidi",
      rawTitle: "Interstellar Main Theme OST",
      rawArtist: "Hans Zimmer",
      youtubeUrl: "https://www.youtube.com/watch?v=zSWdZVtXT7E",
      file: createPipelineMidi(),
      dryRun: false,
    };

    const firstRun = await processPipelineJob(input, repository);

    expect(firstRun).toEqual({
      idempotent: false,
      outcome: "published",
      sheetId: "sheet_1",
      transitions: ["pending", "converting", "scoring", "dedup", "published"],
    });
    expect(repository.sheets).toHaveLength(1);
    expect(repository.jobStatuses).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ status: "converting" }),
      expect.objectContaining({
        status: "scoring",
        qualityScore: expect.any(Number),
        rubricVersion: expect.any(String),
        qualityReasons: expect.any(Array),
      }),
      expect.objectContaining({ status: "dedup" }),
      expect.objectContaining({
        status: "published",
        qualityScore: expect.any(Number),
        rubricVersion: expect.any(String),
        qualityReasons: expect.any(Array),
      }),
    ]);
    expect(repository.revalidated).toEqual([
      [
        "/",
        "/catalog",
        "/artist/hans-zimmer",
        "/genre/soundtrack",
        "/sheet/interstellar-main-theme-ost-hans-zimmer",
      ],
    ]);
    expect(repository.statusTransitions).toEqual([
      "pending",
      "converting",
      "scoring",
      "dedup",
      "published",
    ]);

    const secondRun = await processPipelineJob(input, repository);

    expect(secondRun).toEqual({
      idempotent: true,
      outcome: "published",
      sheetId: "sheet_1",
      transitions: [],
    });
    expect(repository.sheets).toHaveLength(1);
  });

  it("keeps warning-floor quality in review instead of publish", async () => {
    vi.mocked(scoreConversionQuality).mockReturnValueOnce({
      score: 0.93,
      rubricVersion: "v2",
      signals: {
        inRangeRatio: 0.68,
        chordComplexity: 0.82,
        noteDensity: 0.74,
        timingConsistency: 0.81,
      },
      reasons: ["LOW_IN_RANGE_RATIO"],
      stats: {
        totalNotes: 100,
        inRangeNotes: 68,
        averageChordSize: 1.6,
        peakChordSize: 4,
        p95ChordSize: 3,
        hardChordRate: 0.08,
        avgNotesPerSecond: 4.3,
        p95NotesPerSecond: 5.2,
        maxNotesPerSecond: 6.1,
        timingJitter: 0.03,
        gridConfidence: 0.9,
        durationSeconds: 23.255814,
      },
    });

    const repository = new InMemoryPipelineRepository();
    const result = await processPipelineJob(
      {
        sourceUrl: "https://example.com/review.mid",
        sourceSite: "freemidi",
        rawTitle: "Review Song",
        rawArtist: "Review Artist",
        file: createPipelineMidi(),
        dryRun: false,
      },
      repository,
    );

    expect(result.outcome).toBe("needs_review");
    expect(
      repository.jobStatuses.some((status) => status.status === "published"),
    ).toBe(true);
    expect(repository.sheets).toHaveLength(1);
  });
});
