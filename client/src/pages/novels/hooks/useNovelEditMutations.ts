import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { PipelineRepairMode, PipelineRunMode, VolumePlanDocument } from "@ai-novel/shared/types/novel";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  createNovelChapter,
  generateChapterHook,
  optimizeNovelOutlinePreview,
  optimizeNovelStructuredOutlinePreview,
  reviewNovelChapter,
  runNovelPipeline,
  updateNovel,
  syncNovelVolumeChapters,
  updateNovelVolumes,
} from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { buildNovelUpdatePayload, type NovelBasicFormState } from "../novelBasicInfo.shared";
import type { ChapterReviewResult } from "../chapterPlanning.shared";
import type { StructuredSyncOptions } from "../novelEdit.utils";
import { syncNovelWorkflowStageSilently } from "../novelWorkflow.client";

interface LlmSettings {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

interface PipelineFormState {
  startOrder: number;
  endOrder: number;
  maxRetries: number;
  runMode: PipelineRunMode;
  autoReview: boolean;
  autoRepair: boolean;
  skipCompleted: boolean;
  qualityThreshold: number;
  repairMode: PipelineRepairMode;
}

interface UseNovelEditMutationsArgs {
  id: string;
  basicForm: NovelBasicFormState;
  hasCharacters: boolean;
  outlineText: string;
  outlineOptimizeInstruction: string;
  setOutlineOptimizePreview: (value: string) => void;
  setOutlineOptimizeMode: (value: "full" | "selection") => void;
  setOutlineOptimizeSourceText: (value: string) => void;
  structuredDraftText: string;
  structuredOptimizeInstruction: string;
  setStructuredOptimizePreview: (value: string) => void;
  setStructuredOptimizeMode: (value: "full" | "selection") => void;
  setStructuredOptimizeSourceText: (value: string) => void;
  volumeDocument: VolumePlanDocument;
  llm: LlmSettings;
  pipelineForm: PipelineFormState;
  selectedChapterId: string;
  chapterCount: number;
  setActiveTab: (value: string) => void;
  setSelectedChapterId: (value: string) => void;
  setCurrentJobId: (value: string) => void;
  setPipelineMessage: (value: string) => void;
  setStructuredMessage: (value: string) => void;
  setReviewResult: (value: ChapterReviewResult | null) => void;
  queryClient: QueryClient;
  invalidateNovelDetail: () => Promise<void>;
}

export function useNovelEditMutations({
  id,
  basicForm,
  hasCharacters,
  outlineText,
  outlineOptimizeInstruction,
  setOutlineOptimizePreview,
  setOutlineOptimizeMode,
  setOutlineOptimizeSourceText,
  structuredDraftText,
  structuredOptimizeInstruction,
  setStructuredOptimizePreview,
  setStructuredOptimizeMode,
  setStructuredOptimizeSourceText,
  volumeDocument,
  llm,
  pipelineForm,
  selectedChapterId,
  chapterCount,
  setActiveTab,
  setSelectedChapterId,
  setCurrentJobId,
  setPipelineMessage,
  setStructuredMessage,
  setReviewResult,
  queryClient,
  invalidateNovelDetail,
}: UseNovelEditMutationsArgs) {
  const saveBasicMutation = useMutation({
    mutationFn: () => updateNovel(id, buildNovelUpdatePayload(basicForm)),
    onSuccess: async () => {
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "project_setup",
        itemLabel: "项目设定已保存",
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
      if (!hasCharacters) {
        setActiveTab("character");
      }
    },
  });

  const saveOutlineMutation = useMutation({
    mutationFn: () => updateNovelVolumes(id, volumeDocument),
    onSuccess: async () => {
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "volume_strategy",
        itemLabel: "卷战略 / 卷骨架已保存",
        checkpointType: "volume_strategy_ready",
        checkpointSummary: "当前卷战略与卷骨架已保存到工作区。",
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
  });

  const saveStructuredMutation = useMutation({
    mutationFn: () => updateNovelVolumes(id, {
      ...volumeDocument,
      syncToChapterExecution: true,
    }),
    onSuccess: async () => {
      setStructuredMessage("节奏拆章已保存，章节执行区会直接使用同一批章节。");
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "structured_outline",
        itemLabel: "节奏 / 拆章已保存",
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
  });

  const optimizeOutlineMutation = useMutation({
    mutationFn: (payload: { mode: "full" | "selection"; selectedText?: string }) =>
      optimizeNovelOutlinePreview(id, {
        currentDraft: outlineText,
        instruction: outlineOptimizeInstruction,
        mode: payload.mode,
        selectedText: payload.selectedText,
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
      }),
    onSuccess: (response) => {
      setOutlineOptimizePreview(response.data?.optimizedDraft ?? "");
      setOutlineOptimizeMode(response.data?.mode ?? "full");
      setOutlineOptimizeSourceText(response.data?.selectedText ?? "");
    },
  });

  const optimizeStructuredMutation = useMutation({
    mutationFn: (payload: { mode: "full" | "selection"; selectedText?: string }) =>
      optimizeNovelStructuredOutlinePreview(id, {
        currentDraft: structuredDraftText,
        instruction: structuredOptimizeInstruction,
        mode: payload.mode,
        selectedText: payload.selectedText,
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
      }),
    onSuccess: (response) => {
      setStructuredOptimizePreview(response.data?.optimizedDraft ?? "");
      setStructuredOptimizeMode(response.data?.mode ?? "full");
      setStructuredOptimizeSourceText(response.data?.selectedText ?? "");
    },
  });

  const syncStructuredChaptersMutation = useMutation({
    mutationFn: (options: StructuredSyncOptions) => syncNovelVolumeChapters(id, {
      volumes: volumeDocument.volumes,
      preserveContent: options.preserveContent,
      applyDeletes: options.applyDeletes,
      syncMode: "conservative",
    }),
    onSuccess: async (response) => {
      const preview = response.data;
      setStructuredMessage(
        "\u8fde\u63a5\u4fee\u590d\u5b8c\u6210\uff1a\u65b0\u589e" + (preview?.createCount ?? 0) + "\uff0c\u66f4\u65b0" + (preview?.updateCount ?? 0) + "\uff0c\u5220\u9664" + (preview?.deleteCount ?? 0) + "\u3002",
      );
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "structured_outline",
        itemLabel: "\u5377\u7ea7\u62c6\u7ae0\u5df2\u8fde\u63a5\u5230\u7ae0\u8282\u6267\u884c",
        checkpointType: "chapter_batch_ready",
        checkpointSummary: "\u7ae0\u8282\u5217\u8868\u3001\u4efb\u52a1\u5355\u548c\u6267\u884c\u5165\u53e3\u5df2\u51c6\u5907\u597d\uff0c\u53ef\u7ee7\u7eed\u8fdb\u5165\u7ae0\u8282\u6267\u884c\u3002",
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "\u7ae0\u8282\u540c\u6b65\u5931\u8d25\u3002";
      setStructuredMessage(message);
    },
  });

  const rebuildVolumeSyncMutation = useMutation({
    mutationFn: (targetVolumeId: string) => syncNovelVolumeChapters(id, {
      volumes: volumeDocument.volumes,
      syncMode: "rebuild_target_volume",
      targetVolumeId,
    }),
    onSuccess: async (response, targetVolumeId) => {
      const preview = response.data;
      setStructuredMessage(
        "\u672c\u5377\u91cd\u5efa\u5b8c\u6210\uff1a\u5f52\u6863\u66ff\u6362 " + (preview?.deleteCount ?? 0) + " \u4e2a\u65e7\u7ae0\u8282\uff0c\u91cd\u5efa " + (preview?.createCount ?? 0) + " \u4e2a\u65b0\u7ae0\u8282\u3002",
      );
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "structured_outline",
        itemLabel: "\u672c\u5377\u7ae0\u8282\u540c\u6b65\u5df2\u91cd\u5efa",
        checkpointType: "chapter_batch_ready",
        checkpointSummary: "\u5df2\u6309\u5f53\u524d\u62c6\u7ae0\u7ed3\u679c\u91cd\u5efa\u76ee\u6807\u5377 " + targetVolumeId + " \u7684\u6267\u884c\u7ae0\u8282\u6620\u5c04\u3002",
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "\u672c\u5377\u7ae0\u8282\u91cd\u5efa\u5931\u8d25\u3002";
      setStructuredMessage(message);
    },
  });

  const createChapterMutation = useMutation({
    mutationFn: () =>
      createNovelChapter(id, {
        title: `New Chapter ${chapterCount + 1}`,
        order: chapterCount + 1,
        content: "",
      }),
    onSuccess: async (response) => {
      if (response.data?.id) {
        setSelectedChapterId(response.data.id);
      }
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "chapter_execution",
        itemLabel: "已创建新的章节执行项",
        chapterId: response.data?.id,
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
  });

  const runPipelineMutation = useMutation({
    mutationFn: (override?: Partial<PipelineFormState>) =>
      runNovelPipeline(id, {
        startOrder: override?.startOrder ?? pipelineForm.startOrder,
        endOrder: override?.endOrder ?? pipelineForm.endOrder,
        maxRetries: override?.maxRetries ?? pipelineForm.maxRetries,
        runMode: override?.runMode ?? pipelineForm.runMode,
        autoReview: override?.autoReview ?? pipelineForm.autoReview,
        autoRepair: override?.autoRepair ?? pipelineForm.autoRepair,
        skipCompleted: override?.skipCompleted ?? pipelineForm.skipCompleted,
        qualityThreshold: override?.qualityThreshold ?? pipelineForm.qualityThreshold,
        repairMode: override?.repairMode ?? pipelineForm.repairMode,
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
      }),
    onSuccess: async (response) => {
      if (response.data?.id) {
        setCurrentJobId(response.data.id);
      }
      setPipelineMessage(response.message ?? "Pipeline started.");
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "quality_repair",
        itemLabel: "章节流水线运行中",
        status: "running",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.novels.pipelineJob(id, response.data?.id ?? "none") });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: () =>
      reviewNovelChapter(id, selectedChapterId, {
        provider: llm.provider,
        model: llm.model,
        temperature: 0.1,
      }),
    onSuccess: async (response) => {
      setReviewResult(response.data ?? null);
      setPipelineMessage("Chapter reviewed.");
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "quality_repair",
        itemLabel: "章节审校已完成",
        status: "waiting_approval",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.novels.qualityReport(id) });
    },
  });

  const hookMutation = useMutation({
    mutationFn: () =>
      generateChapterHook(id, {
        chapterId: selectedChapterId || undefined,
        provider: llm.provider,
        model: llm.model,
        temperature: llm.temperature,
      }),
    onSuccess: async () => {
      setPipelineMessage("Chapter hook generated.");
      await syncNovelWorkflowStageSilently({
        novelId: id,
        stage: "chapter_execution",
        itemLabel: "章节钩子已生成",
        chapterId: selectedChapterId || undefined,
        status: "waiting_approval",
      });
      await invalidateNovelDetail();
    },
  });

  return {
    saveBasicMutation,
    saveOutlineMutation,
    saveStructuredMutation,
    optimizeOutlineMutation,
    optimizeStructuredMutation,
    syncStructuredChaptersMutation,
    rebuildVolumeSyncMutation,
    createChapterMutation,
    runPipelineMutation,
    reviewMutation,
    hookMutation,
  };
}
