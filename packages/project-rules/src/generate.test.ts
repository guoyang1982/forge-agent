import { describe, expect, it } from "vitest";
import { generateAgentsMd } from "./generate.js";

describe("generateAgentsMd", () => {
  it("renders project guidance with inferred commands", () => {
    const out = generateAgentsMd({
      projectName: "demo",
      runCommands: ["npm run dev"],
      testCommands: ["npm test"],
      conventions: ["Keep edits focused."],
    });

    expect(out).toContain("## Project\ndemo");
    expect(out).toContain("- `npm run dev`");
    expect(out).toContain("- `npm test`");
    expect(out).toContain("- Keep edits focused.");
  });
});
