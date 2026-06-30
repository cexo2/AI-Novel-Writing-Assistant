import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./StructuredOutlineWorkspace.tsx", import.meta.url), "utf8");

test("structured outline workspace exposes rebuild volume sync action separately", () => {
  assert.match(source, /onRebuildVolumeSync/);
  assert.match(source, /isRebuildingVolumeSync/);
  assert.match(source, /\\u91cd\\u5efa\\u672c\\u5377\\u7ae0\\u8282\\u540c\\u6b65/);
  assert.match(source, /\\u4fee\\u590d\\u7ae0\\u8282\\u8fde\\u63a5/);
});
