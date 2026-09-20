import { describe, expect, it } from "vitest";
import { normalizeMailbox } from "./normalize";

describe("normalizeMailbox", () => {
  it("collapses every sub-address and Gmail dot variant onto one mailbox", () => {
    const variants = ["victim@gmail.com", "Victim+1@gmail.com", "v.ic.tim+x@googlemail.com", " VICTIM@GMAIL.COM "];
    expect(new Set(variants.map(normalizeMailbox))).toEqual(new Set(["victim@gmail.com"]));
  });

  it("strips +tags on other providers but keeps their dots", () => {
    expect(normalizeMailbox("first.last+news@outlook.com")).toBe("first.last@outlook.com");
  });

  it("leaves odd input recognisable rather than throwing", () => {
    expect(normalizeMailbox("+tag@example.com")).toBe("+tag@example.com");
    expect(normalizeMailbox("no-at-sign")).toBe("no-at-sign");
  });
});
