import type { VolumePlan } from "@ai-novel/shared/types/novel";
import type { ExistingChapterRecord } from "./volumePlanUtils";

export interface TargetVolumeRebuildCandidates {
  chapterIdsToReplace: string[];
  minChapterOrder: number;
  maxChapterOrder: number;
  targetChapterCount: number;
}

function collectLinkedChapterIds(volume?: VolumePlan | null): string[] {
  if (!volume) {
    return [];
  }
  return volume.chapters
    .map((chapter) => chapter.chapterId?.trim() ?? "")
    .filter(Boolean);
}

function collectChapterOrders(volume?: VolumePlan | null): number[] {
  if (!volume) {
    return [];
  }
  return volume.chapters
    .map((chapter) => chapter.chapterOrder)
    .filter((order) => Number.isInteger(order) && order > 0);
}

export function resolveTargetVolumeRebuildCandidates(params: {
  previousVolumes: VolumePlan[];
  nextVolumes: VolumePlan[];
  targetVolumeId: string;
  existingChapters: ExistingChapterRecord[];
}): TargetVolumeRebuildCandidates {
  const { previousVolumes, nextVolumes, targetVolumeId, existingChapters } = params;
  const previousTargetVolume = previousVolumes.find((volume) => volume.id === targetVolumeId) ?? null;
  const nextTargetVolume = nextVolumes.find((volume) => volume.id === targetVolumeId) ?? null;
  if (!nextTargetVolume) {
    throw new Error("目标卷不存在，无法执行本卷重建同步。");
  }

  const targetOrders = new Set([
    ...collectChapterOrders(previousTargetVolume),
    ...collectChapterOrders(nextTargetVolume),
  ]);
  if (targetOrders.size === 0) {
    throw new Error("目标卷没有可重建的章节规划。");
  }

  const linkedByOtherVolumes = new Set(
    nextVolumes
      .filter((volume) => volume.id !== targetVolumeId)
      .flatMap((volume) => collectLinkedChapterIds(volume)),
  );

  const replaceChapterIds = new Set([
    ...collectLinkedChapterIds(previousTargetVolume),
    ...collectLinkedChapterIds(nextTargetVolume),
  ]);

  for (const chapter of existingChapters) {
    if (!targetOrders.has(chapter.order)) {
      continue;
    }
    if (linkedByOtherVolumes.has(chapter.id)) {
      continue;
    }
    replaceChapterIds.add(chapter.id);
  }

  const orderedTargetOrders = [...targetOrders].sort((left, right) => left - right);
  return {
    chapterIdsToReplace: [...replaceChapterIds],
    minChapterOrder: orderedTargetOrders[0],
    maxChapterOrder: orderedTargetOrders[orderedTargetOrders.length - 1],
    targetChapterCount: nextTargetVolume.chapters.length,
  };
}
