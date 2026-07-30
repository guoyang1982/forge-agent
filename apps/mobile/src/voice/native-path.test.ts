import { describe, expect, it } from "vitest";
import { toNativePath } from "./native-path.js";

describe("toNativePath", () => {
  it("strips file:/// URIs", () => {
    expect(toNativePath("file:///data/user/0/dev.forge.mobile/files/a.wav")).toBe(
      "/data/user/0/dev.forge.mobile/files/a.wav",
    );
  });

  it("strips Java File.toURI() file:/ form", () => {
    expect(toNativePath("file:/data/user/0/dev.forge.mobile/files/a.wav")).toBe(
      "/data/user/0/dev.forge.mobile/files/a.wav",
    );
  });

  it("decodes percent-encoded paths", () => {
    expect(toNativePath("file:/data/user/0/app/files/rec%20ing.wav")).toBe(
      "/data/user/0/app/files/rec ing.wav",
    );
  });

  it("passes through absolute paths", () => {
    expect(toNativePath("/tmp/a.wav")).toBe("/tmp/a.wav");
  });
});
