import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const functionSource = (name) => source.match(
  new RegExp(`function ${name}\\b[\\s\\S]*?\\n}\\n`),
)[0];

function fixture() {
  const state = { runPatches: new Map() };
  const record = (path, options) => state.runPatches.set(path, options);
  return {
    state,
    ...new Function("state", "recordRunModifiedFile", "normalizeWorkspaceRelPath", "getActiveProject", `
      ${source.match(/const IMAGE_FILE_EXT_RE = [^;]+;/)[0]}
      ${["isImageFilePath", "isPlausibleWorkspaceImagePath", "extractImagePathsFromText",
        "mergeConclusionImageFiles", "recordGeneratedImagePathsFromText"].map(functionSource).join("\n")}
      return { mergeConclusionImageFiles, recordGeneratedImagePathsFromText };
    `)(state, record, (_cwd, path) => path, () => ({ cwd: "/project" })),
  };
}

describe("image file ownership", () => {
  it("does not attribute images found in read/search output to the current run", () => {
    const { state, recordGeneratedImagePathsFromText } = fixture();
    recordGeneratedImagePathsFromText("runs/screenshots/mobile-maximized.png\nruns/screenshots/mobile-overview.png\nruns/screenshots/mobile-restored.png");
    expect([...state.runPatches.keys()]).toEqual([]);
  });

  it("does not add referenced images when rendering or restoring a conclusion", () => {
    const { mergeConclusionImageFiles } = fixture();
    expect(mergeConclusionImageFiles(["src/app.ts"], "参考旧图 ![截图](runs/screenshots/mobile-overview.png)"))
      .toEqual(["src/app.ts"]);
  });

  it("preserves images with actual edit evidence without claiming other references", () => {
    const { state, recordGeneratedImagePathsFromText, mergeConclusionImageFiles } = fixture();
    state.runPatches.set("runs/new.png", { source: "tool" });
    recordGeneratedImagePathsFromText("runs/new.png runs/old.png");
    expect([...state.runPatches.keys()]).toEqual(["runs/new.png"]);
    expect(mergeConclusionImageFiles([...state.runPatches.keys()], "runs/old.png"))
      .toEqual(["runs/new.png"]);
  });
});
