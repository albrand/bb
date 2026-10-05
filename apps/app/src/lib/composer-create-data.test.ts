import { expect, it } from "vitest";
import {
  getComposerCreateData,
  setComposerCreateData,
  clearSubmittedComposerCreateData,
} from "./composer-create-data";

it("isolates plugin values and independently mounted drafts across failed and successful sends", () => {
  setComposerCreateData("draft-one", "account-pool", { accountId: "first" });
  setComposerCreateData("draft-one", "another-plugin", { retained: true });
  setComposerCreateData("draft-two", "account-pool", { accountId: "second" });
  const submitted = getComposerCreateData("draft-one");
  expect(getComposerCreateData("draft-two")).toEqual({
    "account-pool": { accountId: "second" },
  });
  expect(getComposerCreateData("draft-one")).toEqual(submitted);
  setComposerCreateData("draft-one", "account-pool", {
    accountId: "changed-during-send",
  });
  clearSubmittedComposerCreateData("draft-one", submitted);
  expect(getComposerCreateData("draft-one")).toEqual({
    "account-pool": { accountId: "changed-during-send" },
    "another-plugin": { retained: true },
  });
  clearSubmittedComposerCreateData(
    "draft-one",
    getComposerCreateData("draft-one"),
  );
  expect(getComposerCreateData("draft-one")).toBeUndefined();
  setComposerCreateData("draft-two", "account-pool", null);
});

it("rejects non-JSON values and oversized data without overwriting a draft's choice", () => {
  setComposerCreateData("invalid-draft", "account-pool", {
    accountId: "first",
  });
  expect(() =>
    setComposerCreateData("invalid-draft", "account-pool", {
      payload: "x".repeat(16_385),
    }),
  ).toThrow("exceeds its limit");
  expect(getComposerCreateData("invalid-draft")).toEqual({
    "account-pool": { accountId: "first" },
  });
  setComposerCreateData("invalid-draft", "account-pool", null);
});
