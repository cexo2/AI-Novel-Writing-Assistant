const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetVolumeRebuildCandidates } = require("../dist/services/novel/volume/volumeRebuildTarget.js");

function createChapter(id, order) {
  return {
    id,
    order,
    title: `Chapter ${order}`,
    content: "",
  };
}

function createVolume(id, chapterIdsByOrder) {
  return {
    id,
    sortOrder: id === "volume-1" ? 1 : 2,
    title: id,
    summary: "",
    openingHook: null,
    mainPromise: null,
    primaryPressureSource: null,
    coreSellingPoint: null,
    escalationMode: null,
    protagonistChange: null,
    midVolumeRisk: null,
    climax: null,
    payoffType: null,
    nextVolumeHook: null,
    resetPoint: null,
    openPayoffs: [],
    status: "active",
    sourceVersionId: null,
    chapters: chapterIdsByOrder.map(([chapterOrder, chapterId]) => ({
      id: `${id}-plan-${chapterOrder}`,
      chapterId,
      chapterOrder,
      title: `Plan ${chapterOrder}`,
      summary: `Summary ${chapterOrder}`,
      purpose: null,
      conflictLevel: null,
      revealLevel: null,
      targetWordCount: null,
      mustAvoid: null,
      taskSheet: null,
      sceneCards: null,
      payoffRefs: [],
    })),
  };
}

test("target volume rebuild only replaces target-linked chapters", () => {
  const result = resolveTargetVolumeRebuildCandidates({
    previousVolumes: [
      createVolume("volume-1", [[1, "chapter-1"], [2, "chapter-2"], [3, "chapter-3"]]),
      createVolume("volume-2", [[6, "chapter-6"]]),
    ],
    nextVolumes: [
      createVolume("volume-1", [[1, null], [2, null], [3, null], [4, null], [5, null]]),
      createVolume("volume-2", [[6, "chapter-6"]]),
    ],
    targetVolumeId: "volume-1",
    existingChapters: [
      createChapter("chapter-1", 1),
      createChapter("chapter-2", 2),
      createChapter("chapter-3", 3),
      createChapter("chapter-6", 6),
    ],
  });

  assert.deepEqual(result.chapterIdsToReplace.sort(), ["chapter-1", "chapter-2", "chapter-3"]);
  assert.equal(result.minChapterOrder, 1);
  assert.equal(result.maxChapterOrder, 5);
  assert.equal(result.targetChapterCount, 5);
});

test("target volume rebuild still includes old longer target range after reset", () => {
  const result = resolveTargetVolumeRebuildCandidates({
    previousVolumes: [
      createVolume("volume-1", [[1, "chapter-1"], [2, "chapter-2"], [3, "chapter-3"], [4, "chapter-4"]]),
    ],
    nextVolumes: [
      createVolume("volume-1", [[1, null], [2, null]]),
    ],
    targetVolumeId: "volume-1",
    existingChapters: [
      createChapter("chapter-1", 1),
      createChapter("chapter-2", 2),
      createChapter("chapter-3", 3),
      createChapter("chapter-4", 4),
    ],
  });

  assert.deepEqual(result.chapterIdsToReplace.sort(), ["chapter-1", "chapter-2", "chapter-3", "chapter-4"]);
  assert.equal(result.minChapterOrder, 1);
  assert.equal(result.maxChapterOrder, 4);
  assert.equal(result.targetChapterCount, 2);
});
