import { describe, expect, it } from "vitest";
import {
  classifyWritingChange,
  findProtectedSpans,
  resolveWritingEdits,
  validateFormattedTranscript,
  type ProposedWritingEdit,
} from "../src/writing-assistance.js";

function proposal(
  original: string,
  replacement: string,
  overrides: Partial<ProposedWritingEdit> = {},
): ProposedWritingEdit {
  return {
    original,
    replacement,
    category: "grammar",
    confidence: "high",
    semanticImpact: "none",
    explanation: null,
    ...overrides,
  };
}

function protectedTexts(text: string, vocabulary: string[] = []): string[] {
  return findProtectedSpans(text, vocabulary).map((span) =>
    text.slice(span.start, span.end),
  );
}

describe("findProtectedSpans", () => {
  it("protects code, paths, identifiers, flags, constants, versions and URLs", () => {
    const text =
      "Run `pnpm test` in apps/server/src then call refreshToken() on user_id with --force, GET https://x.dev/a?b=1 returns 401 on v2.3.1 for AuthService.verify and MAX_RETRIES";
    expect(protectedTexts(text)).toEqual(
      expect.arrayContaining([
        "`pnpm test`",
        "apps/server/src",
        "refreshToken()",
        "user_id",
        "--force",
        "GET",
        "https://x.dev/a?b=1",
        "401",
        "v2.3.1",
        "AuthService.verify",
        "MAX_RETRIES",
      ]),
    );
  });

  it("protects user vocabulary only on word boundaries", () => {
    const text = "Ask Hermes, not Hermeslike tools.";
    expect(protectedTexts(text, ["Hermes"])).toEqual(["Hermes"]);
  });

  it("does not protect ordinary prose or list numbers", () => {
    expect(protectedTexts("1. check the login flow and fix it")).toEqual([]);
  });
});

describe("classifyWritingChange", () => {
  it.each([
    ["are", "is", "agreement"],
    ["expire", "expires", "agreement"],
    ["acessing", "accessing", "spelling"],
    ["the user", "The user", "surface"],
    ["endpoint", "endpoint.", "surface"],
    ["talking", "token", "content"],
    ["allow", "deny", "content"],
    ["is not", "is", "content"],
  ] as const)("%s → %s is %s", (from, to, kind) => {
    expect(classifyWritingChange(from, to)).toBe(kind);
  });
});

describe("resolveWritingEdits", () => {
  const base = {
    behavior: "automatic" as const,
    vocabulary: [],
    complete: true,
  };

  it("auto-applies the safe agreement fix from the spec", () => {
    const target = "The user are authenticated before accessing the endpoint.";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("user are", "user is")],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "are",
        replacement: "is",
        start: target.indexOf("are"),
        disposition: "apply",
      }),
    ]);
  });

  it("splits a bundled multi-word fix into safe per-word edits", () => {
    const target = "Voce pode verificar a configuracao do servidor?";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal(
          "Voce pode verificar a configuracao",
          "Você pode verificar a configuração",
          { category: "spelling" },
        ),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "Voce",
        replacement: "Você",
        disposition: "apply",
      }),
      expect.objectContaining({
        original: "configuracao",
        replacement: "configuração",
        start: target.indexOf("configuracao"),
        disposition: "suggest",
      }),
    ]);
  });

  it("keeps a bundled rewrite whole when any word changes meaning", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Voce pode apagar a configuracao do servidor?",
      proposals: [
        proposal(
          "Voce pode apagar a configuracao",
          "Você pode salvar a configuração",
          {
            category: "spelling",
          },
        ),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        disposition: "suggest",
        semanticImpact: "possible",
      }),
    ]);
  });

  it("auto-applies removing an accidentally repeated word", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Check the the cache before the deploy.",
      proposals: [proposal("the the cache", "the cache")],
    });
    expect(edits).toEqual([
      expect.objectContaining({ disposition: "apply", semanticImpact: "none" }),
    ]);
  });

  it.each([
    ["I had had enough of the flaky test.", "had had", "had"],
    ["I know that that test is flaky.", "that that", "that"],
    ["What it is is a flaky test.", "is is", "is"],
    ["Do not not run the migration.", "not not", "not"],
    ["We don't don't ship on Fridays.", "don't don't", "don't"],
    ["Eu não não vou rodar a migração.", "não não", "não"],
    ["Eu nao nao vou rodar a migracao.", "nao nao", "nao"],
    ["Isso nunca nunca roda.", "nunca nunca", "nunca"],
    ["We never never deploy on Fridays.", "never never", "never"],
    ["Check the the cache before the deploy.", "the the", "the?"],
    ["This is very very important.", "very very", "very"],
    ["It was a long long day.", "long long", "long"],
    ["Isso é muito muito importante.", "muito muito", "muito"],
    ["Tell her her access expires tonight.", "her her", "her"],
    ["Log in in five minutes.", "in in", "in"],
    ["Turn it on on Monday.", "on on", "on"],
    ["O carro para para deixar passar.", "para para", "para"],
    ["Do do come in.", "Do do", "Do"],
    ["So did I. I left early.", "I. I", "I"],
    ["We\nwe deploy on Fridays.", "We\nwe", "We"],
  ])(
    "only suggests removing the repeat in %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement)],
      });
      expect(edits.map((edit) => edit.disposition)).toEqual(["suggest"]);
    },
  );

  it("only suggests removing a repeat that is not adjacent", () => {
    const distant = resolveWritingEdits({
      ...base,
      target: "Check the cache before the deploy.",
      proposals: [proposal("the deploy", "deploy")],
    });
    expect(distant.map((edit) => edit.disposition)).toEqual(["suggest"]);
  });

  it.each([
    ["He is working late tonight.", "He is", "He be"],
    ["They be working late tonight.", "They be", "They are"],
    ["If he was still there, we could reach him.", "he was", "he were"],
    ["If it wasn't late, we would stay.", "it wasn't", "it weren't"],
    ["It is essential that she have the key.", "she have", "she has"],
    ["I insist that he do the review.", "he do", "he does"],
  ])(
    "only suggests a verb change that can carry mood in %s",
    (target, from, to) => {
      expect(
        resolveWritingEdits({
          ...base,
          target,
          proposals: [proposal(from, to)],
        }),
      ).toEqual([expect.objectContaining({ disposition: "suggest" })]);
    },
  );

  it.each([
    ["I is ready to deploy today.", "I is", "I am"],
    ["They doesn't deploy on Fridays.", "They doesn't", "They don't"],
  ])("auto-applies the agreement fix in %s", (target, from, to) => {
    expect(
      resolveWritingEdits({ ...base, target, proposals: [proposal(from, to)] }),
    ).toEqual([expect.objectContaining({ disposition: "apply" })]);
  });

  it("never auto-applies a content-word swap even at high confidence", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "The authentication talking expires before the refresh request.",
      proposals: [
        proposal("talking", "token", {
          category: "speech-recognition",
          semanticImpact: "none",
        }),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "talking",
        replacement: "token",
        disposition: "suggest",
        semanticImpact: "possible",
      }),
    ]);
  });

  it("drops edits that touch protected identifiers, paths or numbers", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "Call refreshTokne() in src/athu.ts with 3000 retries.",
      proposals: [
        proposal("refreshTokne()", "refreshToken()", { category: "spelling" }),
        proposal("src/athu.ts", "src/auth.ts", { category: "spelling" }),
        proposal("3000", "300", { category: "spelling" }),
      ],
    });
    expect(edits).toEqual([]);
  });

  it("drops ambiguous, missing and overlapping originals", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "the cat and the dog",
      proposals: [
        proposal("the", "The", { category: "capitalization" }),
        proposal("bird", "Bird"),
        proposal("the cat", "The kitty", { category: "word-choice" }),
        proposal("cat and", "cats and"),
      ],
    });
    expect(edits.map((edit) => edit.replacement)).toEqual(["The kitty"]);
  });

  it("only suggests when the behavior is suggest or the sentence is unfinished", () => {
    const proposals = [proposal("user are", "user is")];
    const target = "The user are authenticated";
    expect(
      resolveWritingEdits({
        ...base,
        behavior: "suggest",
        target,
        proposals,
      })[0]?.disposition,
    ).toBe("suggest");
    expect(
      resolveWritingEdits({ ...base, complete: false, target, proposals })[0]
        ?.disposition,
    ).toBe("suggest");
    expect(
      resolveWritingEdits({ ...base, behavior: "off", target, proposals }),
    ).toEqual([]);
  });

  it.each([
    ["public", "pubic", "spelling"],
    ["recieve", "receive", "spelling"],
    ["esta", "está", "grammar"],
    ["there", "their", "grammar"],
    ["it's", "its", "grammar"],
    ["we'll", "well", "punctuation"],
    ["everyday", "every day", "spelling"],
    ["deploy", "deployed", "grammar"],
    ["file", "files", "grammar"],
  ] as const)(
    "never auto-applies %s -> %s even when the model calls it harmless",
    (original, replacement, category) => {
      const target = `Please ${original} it now.`;
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement, { category })],
      });
      expect(edits).toEqual([
        expect.objectContaining({ replacement, disposition: "suggest" }),
      ]);
    },
  );

  it("auto-applies agreement and accent fixes whose meaning cannot change", () => {
    const target =
      "Voce disse que nao the users is ready and a error happened.";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal("Voce", "Você", { category: "spelling" }),
        proposal("nao", "não", { category: "spelling" }),
        proposal("users is", "users are"),
        proposal("a error", "an error"),
      ],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["Você", "apply"],
      ["não", "apply"],
      ["are", "apply"],
      ["an", "apply"],
    ]);
  });

  it.each([
    ["Let's eat, grandma", "Let's eat grandma"],
    ["Let's eat grandma", "Let's eat, grandma"],
    ["Is it ready", "Is it ready?"],
    ["Ship it.", "Ship it!"],
  ])(
    "never auto-applies the punctuation change %s -> %s",
    (original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target: `${original} `,
        proposals: [
          proposal(original, replacement, { category: "punctuation" }),
        ],
      });
      expect(edits.map((edit) => edit.disposition)).toEqual(["suggest"]);
    },
  );

  it.each([
    ["const x = 1;", "const", "Const", "capitalization"],
    ["if (ready) return true", "return", "Return", "capitalization"],
    ["let items = [a, b]", "items", "Items", "capitalization"],
    ["echo $HOME | grep user", "user", "User", "capitalization"],
    ["return return value;", "return return", "return", "grammar"],
    ["if (users are ready)", "are", "is", "grammar"],
  ])(
    "never auto-applies an edit on the code-like line %s",
    (target, original, replacement, category) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [
          proposal(original, replacement, {
            category: category as ProposedWritingEdit["category"],
          }),
        ],
      });
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.map((edit) => edit.disposition)).not.toContain("apply");
    },
  );

  it("still auto-applies on a prose line below a code line", () => {
    const target = "const x = 1;\nthe user are ready";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal("const", "Const", { category: "capitalization" }),
        proposal("user are", "user is"),
      ],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["Const", "suggest"],
      ["is", "apply"],
    ]);
  });

  it.each([
    ["Let's eat, grandma. We are late.", "eat, grandma", "eat grandma"],
    ["Let's eat grandma. We are late.", "eat grandma", "eat, grandma"],
    ["Ship it now. Then rest.", "Ship it now", "Ship it now!"],
  ])(
    "never auto-applies a punctuation change inside the finished sentences %j",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [
          proposal(original, replacement, { category: "punctuation" }),
        ],
      });
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.map((edit) => edit.disposition)).not.toContain("apply");
    },
  );

  it("auto-applies capitalization in a sentence that already ends with a period", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "The build passed. we ship tomorrow.",
      proposals: [
        proposal("we ship", "We ship", { category: "capitalization" }),
      ],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["We", "apply"],
    ]);
  });

  it.each([
    ["we ship tomorrow", "we ship tomorrow", "We ship tomorrow."],
    ["return true", "return", "Return"],
    ["return true", "return true", "return true."],
    ["git push origin main", "git", "Git"],
    ["return  true", "return  true", "return true"],
    ["The build passed.\nreturn true", "return", "Return"],
    ["return true // explanation.", "return", "Return"],
    ["return true # explanation.", "return", "Return"],
    ["return true -- explanation.", "return", "Return"],
  ])(
    "only suggests a case, spacing or period change in the unfinished sentence %j",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [
          proposal(original, replacement, { category: "capitalization" }),
        ],
      });
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.map((edit) => edit.disposition)).not.toContain("apply");
    },
  );

  it("still auto-applies agreement in an unfinished sentence", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "the user are ready",
      proposals: [proposal("user are", "user is")],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["is", "apply"],
    ]);
  });

  it("only auto-applies when the model reports no semantic impact", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "The users is here.",
      proposals: [
        proposal("users is", "users are", { semanticImpact: "possible" }),
      ],
    });
    expect(edits[0]?.disposition).toBe("suggest");
  });
});

describe("validateFormattedTranscript", () => {
  it("accepts punctuation and a numbered list built from spoken ordinals", () => {
    expect(
      validateFormattedTranscript(
        "first check authentication second verify refresh tokens third add integration tests",
        "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
      ),
    ).toEqual({ ok: true });
  });

  it("accepts question inference without new words", () => {
    expect(
      validateFormattedTranscript(
        "I think the access token expires too early could this explain the unauthorized response",
        "I think the access token expires too early. Could this explain the unauthorized response?",
      ),
    ).toEqual({ ok: true });
  });

  it("accepts Brazilian Portuguese and code-switching without translating", () => {
    expect(
      validateFormattedTranscript(
        "precisamos corrigir o refresh token antes do deploy",
        "Precisamos corrigir o refresh token antes do deploy.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "precisamos corrigir o refresh token",
        "We need to fix the refresh token.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
  });

  it.each([
    ["make the endpoint public", "Make the endpoint pubic."],
    ["the user are logged in", "The user is logged in."],
    ["it expire tomorrow", "It expires tomorrow."],
    ["deploy code", "Deploy 7 code."],
    ["first check auth second run tests", "1. Check auth.\n2. Run 2 tests."],
    ["check auth run tests", "Check auth. 1. Run tests."],
  ])(
    "keeps the transcript when formatting swaps a spoken word: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "added-words",
      });
    },
  );

  it.each([
    ["deploy code", "7. Deploy code."],
    ["deploy code", "1. Deploy code."],
    ["check auth run tests", "1. Check auth.\n2. Run tests."],
    ["first check auth second run tests", "1. Check auth.\n3. Run tests."],
    ["first check auth second run tests", "2. Check auth.\n1. Run tests."],
    ["first check auth second run tests", "1. Run tests.\n2. Check auth."],
    ["first check auth third run tests", "1. Check auth.\n3. Run tests."],
    ["second run tests first check auth", "2. Run tests.\n1. Check auth."],
    [
      "first check auth second check tokens",
      "1. Check tokens.\n2. Check auth.",
    ],
    [
      "primeiro verificar auth segundo verificar tokens",
      "1. Verificar tokens.\n2. Verificar auth.",
    ],
  ])(
    "keeps the transcript when list numbers do not match the spoken enumeration: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "list-numbers",
      });
    },
  );

  it.each([
    ["first check auth second run tests", "1. Check auth tests.\n2. Run."],
    ["first check auth second run tests", "1. Auth check.\n2. Run tests."],
  ])(
    "keeps the transcript when list items do not keep the words spoken for them: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "list-numbers",
      });
    },
  );

  it("formats a list whose items share a first word when each keeps its own words", () => {
    expect(
      validateFormattedTranscript(
        "first check auth second check tokens",
        "1. Check auth.\n2. Check tokens.",
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["validate config before deploy", "Validate deploy before config."],
    [
      "first validate config before deploy second run tests",
      "1. Validate deploy before config.\n2. Run tests.",
    ],
  ])(
    "keeps the transcript when formatting reorders spoken words: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "reordered",
      });
    },
  );

  it("keeps the transcript when a spoken enumerator numbers no list item", () => {
    expect(
      validateFormattedTranscript(
        "first check auth second run tests",
        "1. Check auth.\nRun tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it.each([
    ["run the migration", "Not run the migration.", ["not"]],
    ["deploy the build", "Deploy the Kubernetes build.", ["Kubernetes"]],
    ["make the endpoint public", "Make the endpoint pubic.", ["pubic"]],
    ["ask hermez about it", "Ask Hermes about it.", ["Hermes"]],
  ])(
    "keeps the transcript when formatting writes a vocabulary term that was not transcribed: %s -> %s",
    (raw, formatted, vocabulary) => {
      expect(validateFormattedTranscript(raw, formatted, vocabulary)).toEqual({
        ok: false,
        reason: "added-words",
      });
    },
  );

  it.each([
    ["nao", "Não não."],
    ["eu nao vou", "Eu não vou, não."],
    ["voce precisa", "Você, você precisa."],
    ["run the migration", "Run the migration, run."],
    ["do not delete it", "Do not delete it, not."],
  ])(
    "keeps the transcript when formatting repeats a word spoken once: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "added-words",
      });
    },
  );

  it("accepts an accent restoration for each time the word was spoken", () => {
    expect(validateFormattedTranscript("nao foi nao", "Não foi não.")).toEqual({
      ok: true,
    });
  });

  it("accepts transcribed vocabulary terms and accent restorations of spoken words", () => {
    expect(
      validateFormattedTranscript(
        "ask hermes about next js",
        "Ask Hermes about Next.js.",
        ["Hermes", "Next.js"],
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript("voce nao precisa", "Você não precisa."),
    ).toEqual({ ok: true });
  });

  it("rejects added requirements and changed numbers", () => {
    expect(
      validateFormattedTranscript(
        "add integration tests",
        "Add comprehensive integration tests.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
    expect(
      validateFormattedTranscript(
        "set the timeout to 3000",
        "Set the timeout to 300.",
      ),
    ).toEqual({ ok: false, reason: "added-words" });
  });

  it("rejects a rewrite that loses a protected identifier", () => {
    expect(
      validateFormattedTranscript(
        "rename user_id in the schema",
        "Rename user id in the schema.",
      ),
    ).toEqual({ ok: false, reason: "protected" });
  });

  it("rejects a formatting that drops most of what was said", () => {
    expect(
      validateFormattedTranscript(
        "please make sure the login form validates the email field and shows an error",
        "Validates email.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it.each([
    ["vai funcionar, né?", "Vai funcionar.", "question"],
    ["it works, eh?", "It works.", "question"],
    ["is the build green?", "The build is green.", "question"],
    ["vai funcionar né", "Vai funcionar.", "dropped-words"],
    [
      "Is the build green? Deploy it tomorrow.",
      "Is the build green. Deploy it tomorrow?",
      "question",
    ],
    [
      "deploy it tomorrow. is it green?",
      "Deploy it tomorrow? Is it green.",
      "question",
    ],
    ["is it green? deploy it.", "Is it green? Deploy it?", "question"],
    ["Deploy！ Is it ready", "Deploy? Is it ready.", "question"],
    ["Deploy． Is it ready", "Deploy? Is it ready.", "question"],
    ["it works eh", "It works.", "dropped-words"],
  ])(
    "keeps the transcript when formatting turns a question into a statement: %s -> %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it("accepts formatting that keeps a question a question", () => {
    expect(
      validateFormattedTranscript("vai funcionar, né?", "Vai funcionar, né?"),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "um is the build green?",
        "Is the build green?",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "is the build green? deploy it tomorrow",
        "Is the build green? Deploy it tomorrow.",
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["deploy auth service at noon no wait at midnight", "Deploy at midnight."],
    [
      "run the unit tests on staging no wait on production",
      "Run on production.",
    ],
    [
      "deploy the api then the worker no wait the web app",
      "Deploy the web app.",
    ],
  ])(
    "keeps the transcript when a self-correction drops more than it replaces: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

  it.each([
    ["I had had enough of the flaky test", "I had enough of the flaky test."],
    ["I know that that test is flaky", "I know that test is flaky."],
    ["what it is is a flaky test", "What it is a flaky test."],
    ["this is very very important", "This is very important."],
    ["it was a long long day", "It was a long day."],
    ["isso é muito muito importante", "Isso é muito importante."],
    ["tell her her access expires tonight", "Tell her access expires tonight."],
    ["log in in five minutes", "Log in five minutes."],
    ["o carro para para deixar passar", "O carro para deixar passar."],
    ["so did i. i left early", "So did I left early."],
  ])(
    "keeps the transcript when formatting drops a repeat that can be meant: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

  it.each([
    [
      "check the the cache before the deploy",
      "Check the cache before the deploy.",
    ],
    [
      "we we should deploy the build of of staging",
      "We should deploy the build of staging.",
    ],
    ["eu eu vou rodar de de novo", "Eu vou rodar de novo."],
  ])(
    "allows formatting to drop a short function word said twice by accident: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
    },
  );

  it.each([
    ["no wait is required", "Wait is required.", "negation"],
    ["there is no wait time today", "There is wait time today.", "negation"],
    ["actually it works", "It works.", "dropped-words"],
  ])(
    "only treats a correction phrase as one when it replaces words before it: %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    ["set the offset to -5", "Set the offset to 5.", "dropped-words"],
    ["set the offset to 5", "Set the offset to -5.", "added-words"],
    ["the delta is −2.5 now", "The delta is 2.5 now.", "dropped-words"],
  ])("keeps the sign of a spoken number: %s", (raw, formatted, reason) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({
      ok: false,
      reason,
    });
  });

  it("accepts a negative number that keeps its sign", () => {
    expect(
      validateFormattedTranscript(
        "set the offset to -5 and the range to 1-3",
        "Set the offset to -5 and the range to 1-3.",
      ),
    ).toEqual({ ok: true });
  });

  it("allows a self-correction to replace the words just before it", () => {
    expect(
      validateFormattedTranscript(
        "deploy auth service at noon no wait at midnight",
        "Deploy auth service at midnight.",
      ),
    ).toEqual({ ok: true });
  });

  it("allows filler removal and self-corrections", () => {
    expect(
      validateFormattedTranscript(
        "um we should deploy on monday no wait on tuesday",
        "We should deploy on Tuesday.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "use the staging database quer dizer o banco de produção",
        "Use o banco de produção.",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a fluent rewrite that loses a negation", () => {
    expect(
      validateFormattedTranscript(
        "do not run the migration on production",
        "Run the migration on production.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
    expect(
      validateFormattedTranscript(
        "don't delete the cache actually just clear it",
        "Delete the cache, just clear it.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
    expect(
      validateFormattedTranscript(
        "não apague o arquivo de log",
        "Apague o arquivo de log.",
      ),
    ).toEqual({ ok: false, reason: "negation" });
  });

  it("rejects a reply that silently loses the end of what was said", () => {
    expect(
      validateFormattedTranscript(
        "check the login flow then verify the refresh tokens and add tests for the logout endpoint",
        "Check the login flow, then verify the refresh tokens.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it("checks literal code output instead of trusting it", () => {
    const literal = { literalCode: true };
    expect(
      validateFormattedTranscript(
        "call refresh token with dash dash force",
        "call refreshToken with --force",
        [],
        literal,
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "call refresh token with dash dash force",
        "call refreshToken with --force && rm -rf build",
        [],
        literal,
      ),
    ).toEqual({ ok: false, reason: "added-words" });
    expect(
      validateFormattedTranscript(
        "do not call refresh token",
        "call refreshToken()",
        [],
        literal,
      ),
    ).toEqual({ ok: false, reason: "negation" });
  });

  it("only drops number words that enumerate the list in order", () => {
    expect(
      validateFormattedTranscript(
        "check the first endpoint then preserve seven retries",
        "1. Check the endpoint.\n2. Preserve retries.",
      ),
    ).toEqual({ ok: false, reason: "list-numbers" });
    expect(
      validateFormattedTranscript(
        "first check auth second run three migrations",
        "1. Check auth.\n2. Run migrations.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
    expect(
      validateFormattedTranscript(
        "primeiro verificar o login segundo rodar os testes",
        "1. Verificar o login.\n2. Rodar os testes.",
      ),
    ).toEqual({ ok: true });
  });

  it("never treats a spoken quantity or an adjective as a list marker", () => {
    expect(
      validateFormattedTranscript(
        "first check auth second run two migrations",
        "1. Check auth.\n2. Run migrations.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
    expect(
      validateFormattedTranscript(
        "check the first endpoint then second run the tests",
        "1. Check the endpoint.\n2. Run the tests.",
      ),
    ).toEqual({ ok: false, reason: "list-numbers" });
    expect(
      validateFormattedTranscript(
        "one check auth two run the tests",
        "1. Check auth.\n2. Run the tests.",
      ),
    ).toEqual({ ok: false, reason: "list-numbers" });
    expect(
      validateFormattedTranscript(
        "first um check auth and then second run the tests",
        "1. Check auth.\n2. Run the tests.",
      ),
    ).toEqual({ ok: true });
  });

  it("drops list connectors and repeated words only when safe", () => {
    expect(
      validateFormattedTranscript(
        "first check auth and then second add the the tests",
        "1. Check auth.\n2. Add the tests.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "check auth and add tests",
        "Check auth, add tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });
});
