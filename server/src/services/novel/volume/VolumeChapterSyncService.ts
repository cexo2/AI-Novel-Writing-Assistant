import type { Prisma } from "@prisma/client";
import type {
  VolumePlanDocument,
  VolumePlan,
  VolumeSyncPreview,
} from "@ai-novel/shared/types/novel";
import {
  assessChapterExecutionContractShape,
  formatChapterTaskSheetQualityFailure,
} from "@ai-novel/shared/types/chapterTaskSheetQuality";
import { prisma } from "../../../db/prisma";
import { AppError } from "../../../middleware/errorHandler";
import type { VolumeUpdateReason } from "../../../events";
import {
  buildVolumeSyncPlan,
  hasPayoffLedgerRelevantPlanChanges,
  type ExistingChapterRecord,
} from "./volumePlanUtils";
import type { VolumeSyncInput } from "./volumeModels";
import { resolveTargetVolumeRebuildCandidates } from "./volumeRebuildTarget";
import {
  mergeVolumeWorkspaceInput,
  serializeVolumeWorkspaceDocument,
} from "./volumeWorkspaceDocument";
import {
  persistActiveVolumeWorkspace,
  runVolumeWorkspaceTransaction,
} from "./volumeWorkspacePersistence";

export interface VolumeChapterSyncServiceDeps {
  ensureVolumeWorkspace: (novelId: string) => Promise<VolumePlanDocument>;
  ensureActiveVersionRecord: (
    tx: Prisma.TransactionClient,
    novelId: string,
    document: VolumePlanDocument,
    diffSummary?: string,
  ) => Promise<{ versionId: string; version: number }>;
  emitVolumeUpdated: (novelId: string, reason: VolumeUpdateReason) => void;
  syncPayoffLedger: (novelId: string) => void;
}

export interface VolumeChapterSyncOptions {
  emitEvent?: boolean;
  syncPayoffLedger?: boolean;
  volumeUpdateReason?: VolumeUpdateReason;
}

export class VolumeChapterSyncService {
  constructor(private readonly deps: VolumeChapterSyncServiceDeps) {}

  private buildTargetVolumeRebuildPreview(params: {
    targetVolume: VolumePlan;
    existingChapters: ExistingChapterRecord[];
    chapterIdsToReplace: string[];
  }): VolumeSyncPreview {
    const { targetVolume, existingChapters, chapterIdsToReplace } = params;
    const existingById = new Map(existingChapters.map((chapter) => [chapter.id, chapter] as const));
    const deleteItems = chapterIdsToReplace
      .map((chapterId) => existingById.get(chapterId))
      .filter((chapter): chapter is ExistingChapterRecord => Boolean(chapter))
      .sort((left, right) => left.order - right.order)
      .map((chapter) => ({
        action: "delete" as const,
        volumeTitle: targetVolume.title,
        chapterOrder: chapter.order,
        nextTitle: chapter.title,
        previousTitle: chapter.title,
        hasContent: Boolean(chapter.content?.trim()),
        changedFields: [],
      }));
    const createItems = targetVolume.chapters.map((chapter) => ({
      action: "create" as const,
      volumeTitle: targetVolume.title,
      chapterOrder: chapter.chapterOrder,
      nextTitle: chapter.title,
      previousTitle: "",
      hasContent: false,
      changedFields: ["title", "summary", "purpose", "taskSheet"],
    }));

    return {
      createCount: targetVolume.chapters.length,
      updateCount: 0,
      keepCount: 0,
      moveCount: 0,
      deleteCount: chapterIdsToReplace.length,
      deleteCandidateCount: chapterIdsToReplace.length,
      affectedGeneratedCount: deleteItems.filter((item) => item.hasContent).length,
      clearContentCount: 0,
      affectedVolumeCount: 1,
      items: [...deleteItems, ...createItems],
    };
  }

  private async assertTargetVolumeRebuildIsIdle(params: {
    novelId: string;
    targetVolume: VolumePlan;
    chapterIdsToReplace: string[];
    minChapterOrder: number;
    maxChapterOrder: number;
  }): Promise<void> {
    const {
      novelId,
      targetVolume,
      chapterIdsToReplace,
      minChapterOrder,
      maxChapterOrder,
    } = params;
    const [activePipelineJob, activeAutoDirectorTask, generatingChapter] = await Promise.all([
      prisma.generationJob.findFirst({
        where: {
          novelId,
          status: { in: ["queued", "running"] },
          startOrder: { lte: maxChapterOrder },
          endOrder: { gte: minChapterOrder },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, startOrder: true, endOrder: true },
      }),
      prisma.novelWorkflowTask.findFirst({
        where: {
          novelId,
          lane: "auto_director",
          status: { in: ["queued", "running", "waiting_approval"] },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true },
      }),
      prisma.chapter.findFirst({
        where: {
          novelId,
          id: { in: chapterIdsToReplace },
          chapterStatus: "generating",
        },
        select: { id: true, order: true, title: true },
      }),
    ]);

    if (activePipelineJob) {
      throw new AppError(
        `第${targetVolume.sortOrder}卷正在被章节流水线占用（范围 ${activePipelineJob.startOrder}-${activePipelineJob.endOrder}），请等待当前任务结束后再重建。`,
        409,
      );
    }
    if (activeAutoDirectorTask) {
      throw new AppError(
        `当前小说仍有自动导演任务“${activeAutoDirectorTask.title}”在运行或等待处理，请先结束该任务，再重建本卷章节同步。`,
        409,
      );
    }
    if (generatingChapter) {
      throw new AppError(
        `第${generatingChapter.order}章“${generatingChapter.title}”仍在生成中，请等待该章节空闲后再重建本卷。`,
        409,
      );
    }
  }

  private applyChapterLinks(
    volumes: VolumePlan[],
    links: Array<{ volumeChapterId: string; chapterId: string }>,
  ): VolumePlan[] {
    if (links.length === 0) {
      return volumes;
    }
    const chapterIdByVolumeChapterId = new Map(links.map((link) => [link.volumeChapterId, link.chapterId]));
    return volumes.map((volume) => ({
      ...volume,
      chapters: volume.chapters.map((chapter) => {
        const chapterId = chapterIdByVolumeChapterId.get(chapter.id);
        return chapterId && chapter.chapterId !== chapterId
          ? { ...chapter, chapterId }
          : chapter;
      }),
    }));
  }

  async syncVolumeChaptersWithOptions(
    novelId: string,
    input: VolumeSyncInput,
    options: VolumeChapterSyncOptions = {},
  ): Promise<VolumeSyncPreview> {
    const workspace = await this.deps.ensureVolumeWorkspace(novelId);
    const mergedDocument = mergeVolumeWorkspaceInput(novelId, workspace, { volumes: input.volumes });
    if (input.syncMode === "rebuild_target_volume") {
      return this.rebuildTargetVolumeChapters(novelId, workspace, mergedDocument, input, options);
    }
    this.assertSyncableChapterExecutionContracts(mergedDocument, input.executionContractChapterRange);
    const shouldSyncPayoffLedger = hasPayoffLedgerRelevantPlanChanges(workspace.volumes, mergedDocument.volumes);
    const existingChapters = await prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
        generationState: true,
        chapterStatus: true,
        expectation: true,
        targetWordCount: true,
        conflictLevel: true,
        revealLevel: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
      },
    });
    const plan = buildVolumeSyncPlan(
      mergedDocument.volumes,
      existingChapters as ExistingChapterRecord[],
      {
        preserveContent: input.preserveContent !== false,
        applyDeletes: input.applyDeletes === true,
      },
    );

    await runVolumeWorkspaceTransaction(async (tx) => {
      const { versionId } = await this.deps.ensureActiveVersionRecord(tx, novelId, mergedDocument);
      const linkUpdates: Array<{ volumeChapterId: string; chapterId: string }> = [...plan.links];
      for (const item of plan.creates) {
        const created = await tx.chapter.create({
          data: {
            novelId,
            title: item.chapter.title,
            order: item.chapter.chapterOrder,
            content: "",
            expectation: item.chapter.purpose?.trim() || item.chapter.summary,
            targetWordCount: item.chapter.targetWordCount ?? null,
            conflictLevel: item.chapter.conflictLevel ?? null,
            revealLevel: item.chapter.revealLevel ?? null,
            mustAvoid: item.chapter.mustAvoid ?? null,
            taskSheet: item.chapter.taskSheet?.trim() || null,
            sceneCards: item.chapter.sceneCards ?? null,
          },
        });
        item.chapter.chapterId = created.id;
        linkUpdates.push({ volumeChapterId: item.chapter.id, chapterId: created.id });
      }
      for (const item of plan.updates) {
        item.chapter.chapterId = item.chapterId;
        await tx.chapter.updateMany({
          where: { id: item.chapterId, novelId },
          data: {
            title: item.chapter.title,
            order: item.chapter.chapterOrder,
            expectation: item.chapter.purpose?.trim() || item.chapter.summary,
            targetWordCount: item.chapter.targetWordCount ?? null,
            conflictLevel: item.chapter.conflictLevel ?? null,
            revealLevel: item.chapter.revealLevel ?? null,
            mustAvoid: item.chapter.mustAvoid ?? null,
            taskSheet: item.chapter.taskSheet?.trim() || null,
            sceneCards: item.chapter.sceneCards ?? null,
            ...(!item.preserveWorkflowState
              ? {
                generationState: "planned",
                chapterStatus: "unplanned",
              }
              : {}),
            ...(item.clearContent ? { content: "" } : {}),
          },
        });
      }
      if (plan.updates.length > 0) {
        await tx.storyPlan.updateMany({
          where: { novelId, level: "chapter", chapterId: { in: plan.updates.map((item) => item.chapterId) } },
          data: { status: "stale" },
        });
      }
      for (const item of plan.deletes) {
        await tx.chapter.deleteMany({
          where: { id: item.chapterId, novelId },
        });
      }
      const linkedDocument = {
        ...mergedDocument,
        volumes: this.applyChapterLinks(mergedDocument.volumes, linkUpdates),
        activeVersionId: versionId,
        source: "volume" as const,
      };
      await tx.volumePlanVersion.update({
        where: { id: versionId },
        data: {
          contentJson: serializeVolumeWorkspaceDocument(linkedDocument),
        },
      });
      await persistActiveVolumeWorkspace(tx, novelId, linkedDocument, versionId);
    });

    if (options.emitEvent !== false) {
      this.deps.emitVolumeUpdated(novelId, options.volumeUpdateReason ?? "chapter_sync");
    }
    if (options.syncPayoffLedger ?? shouldSyncPayoffLedger) {
      this.deps.syncPayoffLedger(novelId);
    }
    return plan.preview;
  }

  private async rebuildTargetVolumeChapters(
    novelId: string,
    workspace: VolumePlanDocument,
    mergedDocument: VolumePlanDocument,
    input: VolumeSyncInput,
    options: VolumeChapterSyncOptions,
  ): Promise<VolumeSyncPreview> {
    const targetVolumeId = input.targetVolumeId?.trim();
    if (!targetVolumeId) {
      throw new AppError("重建本卷章节同步缺少目标卷。", 400);
    }
    const targetVolume = mergedDocument.volumes.find((volume) => volume.id === targetVolumeId);
    if (!targetVolume) {
      throw new AppError("目标卷不存在，无法重建本卷章节同步。", 404);
    }
    const startOrder = targetVolume.chapters[0]?.chapterOrder;
    const endOrder = targetVolume.chapters[targetVolume.chapters.length - 1]?.chapterOrder;
    if (typeof startOrder === "number" && typeof endOrder === "number") {
      this.assertSyncableChapterExecutionContracts(mergedDocument, {
        startOrder,
        endOrder,
      });
    }

    const existingChapters = await prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        order: true,
        title: true,
        content: true,
        generationState: true,
        chapterStatus: true,
        expectation: true,
        targetWordCount: true,
        conflictLevel: true,
        revealLevel: true,
        mustAvoid: true,
        taskSheet: true,
        sceneCards: true,
      },
    });
    const replacement = resolveTargetVolumeRebuildCandidates({
      previousVolumes: workspace.volumes,
      nextVolumes: mergedDocument.volumes,
      targetVolumeId,
      existingChapters: existingChapters as ExistingChapterRecord[],
    });
    await this.assertTargetVolumeRebuildIsIdle({
      novelId,
      targetVolume,
      chapterIdsToReplace: replacement.chapterIdsToReplace,
      minChapterOrder: replacement.minChapterOrder,
      maxChapterOrder: replacement.maxChapterOrder,
    });

    const shouldSyncPayoffLedger = hasPayoffLedgerRelevantPlanChanges(workspace.volumes, mergedDocument.volumes);
    const preview = this.buildTargetVolumeRebuildPreview({
      targetVolume,
      existingChapters: existingChapters as ExistingChapterRecord[],
      chapterIdsToReplace: replacement.chapterIdsToReplace,
    });

    await runVolumeWorkspaceTransaction(async (tx) => {
      const { versionId } = await this.deps.ensureActiveVersionRecord(tx, novelId, mergedDocument);
      if (replacement.chapterIdsToReplace.length > 0) {
        await tx.storyPlan.updateMany({
          where: {
            novelId,
            level: "chapter",
            chapterId: { in: replacement.chapterIdsToReplace },
          },
          data: {
            status: "stale",
            chapterId: null,
          },
        });
        await tx.chapter.deleteMany({
          where: {
            novelId,
            id: { in: replacement.chapterIdsToReplace },
          },
        });
      }

      const linkedVolumes = mergedDocument.volumes.map((volume) => {
        if (volume.id !== targetVolumeId) {
          return volume;
        }
        return {
          ...volume,
          chapters: volume.chapters.map((chapter) => ({
            ...chapter,
            chapterId: null,
          })),
        };
      });

      const rebuiltTargetChapters: Array<{ volumeChapterId: string; chapterId: string }> = [];
      for (const chapter of targetVolume.chapters) {
        const created = await tx.chapter.create({
          data: {
            novelId,
            title: chapter.title,
            order: chapter.chapterOrder,
            content: "",
            expectation: chapter.purpose?.trim() || chapter.summary,
            targetWordCount: chapter.targetWordCount ?? null,
            conflictLevel: chapter.conflictLevel ?? null,
            revealLevel: chapter.revealLevel ?? null,
            mustAvoid: chapter.mustAvoid ?? null,
            taskSheet: chapter.taskSheet?.trim() || null,
            sceneCards: chapter.sceneCards ?? null,
            generationState: "planned",
            chapterStatus: "unplanned",
          },
        });
        rebuiltTargetChapters.push({
          volumeChapterId: chapter.id,
          chapterId: created.id,
        });
      }

      const linkedDocument = {
        ...mergedDocument,
        volumes: this.applyChapterLinks(linkedVolumes, rebuiltTargetChapters),
        activeVersionId: versionId,
        source: "volume" as const,
      };
      await tx.volumePlanVersion.update({
        where: { id: versionId },
        data: {
          contentJson: serializeVolumeWorkspaceDocument(linkedDocument),
        },
      });
      await persistActiveVolumeWorkspace(tx, novelId, linkedDocument, versionId);
    });

    if (options.emitEvent !== false) {
      this.deps.emitVolumeUpdated(novelId, options.volumeUpdateReason ?? "chapter_sync");
    }
    if (options.syncPayoffLedger ?? shouldSyncPayoffLedger) {
      this.deps.syncPayoffLedger(novelId);
    }
    return preview;
  }

  private assertSyncableChapterExecutionContracts(
    document: VolumePlanDocument,
    chapterRange?: VolumeSyncInput["executionContractChapterRange"],
  ): void {
    for (const volume of document.volumes) {
      for (const chapter of volume.chapters) {
        if (
          chapterRange
          && (chapter.chapterOrder < chapterRange.startOrder || chapter.chapterOrder > chapterRange.endOrder)
        ) {
          continue;
        }
        const hasExecutionArtifact = Boolean(chapter.taskSheet?.trim() || chapter.sceneCards?.trim());
        if (!hasExecutionArtifact) {
          continue;
        }
        const result = assessChapterExecutionContractShape({
          novelId: document.novelId,
          volumeId: volume.id,
          chapterId: chapter.id,
          chapterOrder: chapter.chapterOrder,
          title: chapter.title,
          summary: chapter.summary,
          purpose: chapter.purpose,
          exclusiveEvent: chapter.exclusiveEvent,
          endingState: chapter.endingState,
          nextChapterEntryState: chapter.nextChapterEntryState,
          conflictLevel: chapter.conflictLevel,
          revealLevel: chapter.revealLevel,
          targetWordCount: chapter.targetWordCount,
          mustAvoid: chapter.mustAvoid,
          payoffRefs: chapter.payoffRefs,
          taskSheet: chapter.taskSheet,
          sceneCards: chapter.sceneCards,
        });
        if (!result.canEnterExecution) {
          throw new Error(`\u7b2c ${chapter.chapterOrder} \u7ae0\u6267\u884c\u5408\u540c\u672a\u901a\u8fc7\u8d28\u91cf\u95e8\u7981\uff0c\u4e0d\u80fd\u8fde\u63a5\u5230\u7ae0\u8282\u6267\u884c\u533a\u3002${formatChapterTaskSheetQualityFailure(result)}`);
        }
      }
    }
  }
}
