import { describe, expect, it } from "vitest";
import { suggestLanguage } from "./languageHint";

describe("suggestLanguage", () => {
  it("suggests a clear script without forcing a decision", () => {
    expect(suggestLanguage("This is a long English sentence about an ordinary library visit.")).toBe("en");
    expect(suggestLanguage("我在社区图书馆里整理了很多旧书，也听志愿者讲述了几段经历。")).toBe("zh");
    expect(suggestLanguage("This abstract explains the local library project in detail.\n\n我在社区图书馆里整理了很多旧书，也听志愿者讲述了几段经历。")).toBe("bi");
    expect(suggestLanguage("Hi")).toBeNull();
  });
});
