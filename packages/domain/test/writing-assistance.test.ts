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

  it("only suggests the agreement fix from the spec", () => {
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
        disposition: "suggest",
      }),
    ]);
  });

  it("auto-applies the article fix a to an", () => {
    const target = "We saw a error in the deploy log.";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("a error", "an error")],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "a",
        replacement: "an",
        start: target.indexOf("a error"),
        disposition: "apply",
      }),
    ]);
  });

  it.each([
    ["Set mode A error budget to low.", "A error", "An error"],
    ["A error occurred in the deploy log.", "A error", "An error"],
    ["Pick column An apple from the list.", "An apple", "A apple"],
  ])(
    "only suggests an article fix on a capital A, which can be a label: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement)],
      });
      expect(edits).toEqual([
        expect.objectContaining({ disposition: "suggest" }),
      ]);
    },
  );

  it.each([
    ["Ask Nao about the deploy.", "Nao", "Não"],
    ["Nao vou rodar a migracao.", "Nao", "Não"],
    ["Voce pode verificar o servidor?", "Voce", "Você"],
  ])(
    "only suggests an accent on a capitalized word, which can be a name: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement, { category: "spelling" })],
      });
      expect(edits).toEqual([
        expect.objectContaining({ disposition: "suggest" }),
      ]);
    },
  );

  it("splits a bundled multi-word fix into safe per-word edits", () => {
    const target = "Então voce pode verificar a configuracao do servidor?";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal(
          "voce pode verificar a configuracao",
          "você pode verificar a configuração",
          { category: "spelling" },
        ),
      ],
    });
    expect(edits).toEqual([
      expect.objectContaining({
        original: "voce",
        replacement: "você",
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
    ["The words 'the the' must remain unchanged.", "the the", "the"],
    ['The words "the the" must remain unchanged.', "the the", "the"],
    ["The words “the the” must remain unchanged.", "the the", "the"],
    ["The words ‘the the’ must remain unchanged.", "the the", "the"],
    ["Type 'check the the cache' exactly.", "the the", "the"],
    ["Ele disse «verifique o o cache» duas vezes.", "o o", "o"],
    ['The log says "a error occurred" twice.', "a error", "an error"],
    ["The sign at 5' reads 'the the' exactly.", "the the", "the"],
    ["“They said ‘the the’ yesterday.”", "the the", "the"],
    ["«Ele disse “verifique o o cache” ontem.»", "o o", "o"],
    ["'We don't keep the the cache,' she said.", "the the", "the"],
    ['She said "we said\nthe the cache."', "the the", "the"],
    ["She said “we said\nthe the cache.”", "the the", "the"],
    ["She said “we said\r\nthe the cache.”", "the the", "the"],
    ['Note "unfinished.\n\nThen check the the cache.', "the the", "the"],
    ['Note "unfinished.\r\n\r\nThen check the the cache.', "the the", "the"],
    ["Note “unfinished.\r\n \r\nThen check the the cache.", "the the", "the"],
    ["„quoted” then the the cache.", "the the", "the"],
    ["She said ‘we said\n\tthe the cache’ twice.", "the the", "the"],
    ["‘quoted' then the the cache.", "the the", "the"],
    ["'quoted’ then the the cache.", "the the", "the"],
  ])(
    "only suggests an edit inside quoted text: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement)],
      });
      expect(edits).toEqual([
        expect.objectContaining({ disposition: "suggest" }),
      ]);
    },
  );

  it.each([
    ["We don't check the the cache.", "the the", "the"],
    ["She said 'hi' and then checked the the cache.", "the the", "the"],
    ["She said ‘hi’ and then checked the the cache.", "the the", "the"],
    ["The sign at 5' reads the the sign.", "the the", "the"],
    ["The users' cache needs the the fix.", "the the", "the"],
    ["She said “we were\ndone.” Then check the the cache.", "the the", "the"],
    ["„quoted“ then the the cache.", "the the", "the"],
    ["The log says a error occurred twice.", "a error", "an error"],
  ])(
    "still applies outside quoted text: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [proposal(original, replacement)],
      });
      expect(edits).toEqual([
        expect.objectContaining({ disposition: "apply" }),
      ]);
    },
  );

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
    ["Check the\tthe cache.", "the\tthe", "the"],
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

  it("auto-applies removing a repeat whose second word is lowercase at a sentence start", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "The the cache is stale.",
      proposals: [proposal("The the cache", "The cache")],
    });
    expect(edits.map((edit) => edit.disposition)).toEqual(["apply"]);
  });

  it.each([
    ["The The album is remastered.", "The The album", "The album"],
    ["I saw The The live.", "The The live", "The live"],
  ])(
    "only suggests removing a repeat whose second word is capitalised, as in a name: %s",
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
    ["The fish are nearby.", "fish are", "fish is"],
    ["The fish is nearby.", "fish is", "fish are"],
    ["The sheep isn't hungry.", "sheep isn't", "sheep aren't"],
    ["The data haven't changed.", "data haven't", "data hasn't"],
    ["The staff don't agree.", "staff don't", "staff doesn't"],
    ["I is ready to deploy today.", "I is", "I am"],
    ["They doesn't deploy on Fridays.", "They doesn't", "They don't"],
    ["The ones who made it are here.", "it are", "it is"],
  ])(
    "only suggests the number agreement change in %s, since the subject can be singular or plural",
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
    [
      "They doesn't deploy on Fridays.",
      "They doesn't",
      "They don't",
      "doesn't",
      "don't",
    ],
    [
      "The data haven't changed.",
      "data haven't",
      "data hasn't",
      "haven't",
      "hasn't",
    ],
  ])(
    "keeps the contraction whole in the edit for %s",
    (target, from, to, original, replacement) => {
      expect(
        resolveWritingEdits({
          ...base,
          target,
          proposals: [proposal(from, to)],
        }),
      ).toEqual([
        expect.objectContaining({
          original,
          replacement,
          start: target.indexOf(original),
          end: target.indexOf(original) + original.length,
        }),
      ]);
    },
  );

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
    const proposals = [proposal("a error", "an error")];
    const target = "We saw a error";
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

  it("auto-applies article and accent fixes whose meaning cannot change and only suggests agreement", () => {
    const target =
      "E voce disse que nao the users is ready and a error happened.";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal("voce", "você", { category: "spelling" }),
        proposal("nao", "não", { category: "spelling" }),
        proposal("users is", "users are"),
        proposal("a error", "an error"),
      ],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["você", "apply"],
      ["não", "apply"],
      ["are", "suggest"],
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
    ["x + y.", "x", "X", "capitalization"],
    ["x+y", "x", "X", "capitalization"],
    ["total * rate.", "total", "Total", "capitalization"],
    ["n ^ k", "n", "N", "capitalization"],
    ["price - discount.", "price", "Price", "capitalization"],
    ["count % size", "count", "Count", "capitalization"],
    ["we saw a error in x + y", "a error", "an error", "grammar"],
    ["echo $HOME | grep user", "user", "User", "capitalization"],
    ["return return value;", "return return", "return", "grammar"],
    ["if (we saw a error)", "a error", "an error", "grammar"],
    ["status: we saw a error", "a error", "an error", "grammar"],
    ["  - status: we saw a error", "a error", "an error", "grammar"],
    ['"status": we saw a error', "a error", "an error", "grammar"],
    ["'status': we saw a error", "a error", "an error", "grammar"],
    ['title "we saw a error"', "a error", "an error", "grammar"],
    ['title "draft" we saw a error', "a error", "an error", "grammar"],
    ["url http:example we saw a error", "a error", "an error", "grammar"],
    ["    we saw a error", "a error", "an error", "grammar"],
    ["\twe saw a error", "a error", "an error", "grammar"],
    ["~~~yaml\nwe saw a error", "a error", "an error", "grammar"],
    ["~~~~\n~~~\nwe saw a error", "a error", "an error", "grammar"],
    ["~~~\n~~~yaml\nwe saw a error", "a error", "an error", "grammar"],
    ["````\n```\nwe saw a error", "a error", "an error", "grammar"],
    ["```\n```js\nwe saw a error", "a error", "an error", "grammar"],
    ["echo we saw a error.", "a error", "an error", "grammar"],
    ["printf we saw a error.", "a error", "an error", "grammar"],
    ["$ echo we saw a error.", "a error", "an error", "grammar"],
    ["  sudo echo we saw a error.", "a error", "an error", "grammar"],
    ["git commit -m we saw a error.", "a error", "an error", "grammar"],
    ["Run it.\ngit tag we saw a error.", "a error", "an error", "grammar"],
    ["ls -la we saw a error.", "a error", "an error", "grammar"],
    ["next pass -rf so we saw a error.", "a error", "an error", "grammar"],
    ["Write-Output we saw a error.", "a error", "an error", "grammar"],
    ["Get-ChildItem we saw a error", "a error", "an error", "grammar"],
    ["write-output we saw a error.", "a error", "an error", "grammar"],
    ["$ Write-Host we saw a error.", "a error", "an error", "grammar"],
    ["ConvertTo-Json we saw a error.", "a error", "an error", "grammar"],
    ["ForEach-Object we saw a error.", "a error", "an error", "grammar"],
    ["measure-object we saw a error.", "a error", "an error", "grammar"],
    ["get-ChildItem we saw a error.", "a error", "an error", "grammar"],
    ["Fetch-Data we saw a error.", "a error", "an error", "grammar"],
    ["fetch-data we saw a error.", "a error", "an error", "grammar"],
    ["Well-known teams say we saw a error.", "a error", "an error", "grammar"],
    ["long-term we saw a error.", "a error", "an error", "grammar"],
    ["& Fetch-Data we saw a error.", "a error", "an error", "grammar"],
    ["& fetch-data we saw a error.", "a error", "an error", "grammar"],
    ["& notepad we saw a error.", "a error", "an error", "grammar"],
    [". setup we saw a error.", "a error", "an error", "grammar"],
    ["fetch_data we saw a error.", "a error", "an error", "grammar"],
    ["Fetch_Data we saw a error.", "a error", "an error", "grammar"],
    ["_fetch we saw a error.", "a error", "an error", "grammar"],
    ["$ fetch_data we saw a error.", "a error", "an error", "grammar"],
    ["fetchData we saw a error.", "a error", "an error", "grammar"],
    ["FetchData we saw a error.", "a error", "an error", "grammar"],
    ["getUserName we saw a error.", "a error", "an error", "grammar"],
    ["make sure we saw a error.", "a error", "an error", "grammar"],
    ["find out if we saw a error.", "a error", "an error", "grammar"],
    ["go check that we saw a error.", "a error", "an error", "grammar"],
    ["test that we saw a error.", "a error", "an error", "grammar"],
    ["open the page so we saw a error.", "a error", "an error", "grammar"],
    ["export the users so we saw a error.", "a error", "an error", "grammar"],
    ["tail the log so we saw a error.", "a error", "an error", "grammar"],
    ["kill it so we saw a error.", "a error", "an error", "grammar"],
    ["read we saw a error.", "a error", "an error", "grammar"],
    ["typeset we saw a error.", "a error", "an error", "grammar"],
    ["local we saw a error.", "a error", "an error", "grammar"],
    ["print we saw a error.", "a error", "an error", "grammar"],
    ["trap we saw a error.", "a error", "an error", "grammar"],
    ["wait so we saw a error.", "a error", "an error", "grammar"],
    ["stat we saw a error.", "a error", "an error", "grammar"],
    ["basename we saw a error.", "a error", "an error", "grammar"],
    ["for value in we saw a error", "a error", "an error", "grammar"],
    [
      "for value in we saw a error\ndo\n  echo $value\ndone",
      "a error",
      "an error",
      "grammar",
    ],
    ["while we saw a error", "a error", "an error", "grammar"],
    ["until we saw a error", "a error", "an error", "grammar"],
    ["if we saw a error", "a error", "an error", "grammar"],
    ["case we saw a error", "a error", "an error", "grammar"],
    ["select we saw a error", "a error", "an error", "grammar"],
    ["function we saw a error", "a error", "an error", "grammar"],
    ["time we saw a error", "a error", "an error", "grammar"],
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

  it.each([
    "we saw a error.",
    "Echo said we saw a error.",
    "Make sure we saw a error.",
    "Find out if we saw a error.",
    "Go check that we saw a error.",
    "Test that we saw a error.",
    "Read we saw a error.",
    "Wait so we saw a error.",
    "If we saw a error, ship it.",
    "While we saw a error, wait.",
    "For now we saw a error.",
    "A well-known team says we saw a error.",
    "The long-term plan says we saw a error.",
    "Ask the team - we saw a error.",
    "Tom & Jerry say we saw a error.",
    "OK we saw a error.",
    "AI teams say we saw a error.",
    "Setup says we saw a error.",
    "The fetch_data step says we saw a error.",
    "notepad we saw a error.",
  ])("still auto-applies a safe fix on the prose line %s", (target) => {
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("a error", "an error")],
    });
    expect(edits.map((edit) => edit.disposition)).toEqual(["apply"]);
  });

  it.each([
    "```\nwe saw a error\n```",
    "~~~\nwe saw a error\n~~~",
    "````\nwe saw a error\n````",
    "```yaml\n~~~\nwe saw a error",
    "~~~\n```\nwe saw a error",
  ])("never auto-applies inside a fence: %s", (target) => {
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("a error", "an error")],
    });
    expect(edits.map((edit) => edit.disposition)).not.toContain("apply");
  });

  it.each([
    "~~~text the the\nprint('ok')\n~~~",
    "~~~~ the the\nprint('ok')\n~~~~",
    "  ~~~text the the\nprint('ok')\n~~~",
    "Notes for the release\n~~~text the the",
  ])("only suggests an edit on a fence line: %s", (target) => {
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("the the", "the")],
    });
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.map((edit) => edit.disposition)).not.toContain("apply");
  });

  it.each([
    "```\nconst x = 1;\n```\nwe saw a error",
    "~~~\nconst x = 1;\n~~~\nwe saw a error",
    "````\nconst x = 1;\n`````\nwe saw a error",
    "```\n~~~\n```\nwe saw a error",
    "We met at noon: we saw a error",
    "  we saw a error",
  ])("still auto-applies on a prose line: %s", (target) => {
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [proposal("a error", "an error")],
    });
    expect(edits.map((edit) => edit.disposition)).toEqual(["apply"]);
  });

  it("still auto-applies on a prose line below a code line", () => {
    const target = "const x = 1;\nwe saw a error";
    const edits = resolveWritingEdits({
      ...base,
      target,
      proposals: [
        proposal("const", "Const", { category: "capitalization" }),
        proposal("a error", "an error"),
      ],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["Const", "suggest"],
      ["an", "apply"],
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

  it.each([
    ["I want turkey for dinner.", "turkey", "Turkey"],
    ["We flew to Turkey last week.", "Turkey", "turkey"],
    ["Ask apple support about it.", "apple", "Apple"],
    ["The build passed. we ship tomorrow.", "we ship", "WE ship"],
  ])(
    "only suggests a case change that is not a sentence start or I: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [
          proposal(original, replacement, { category: "capitalization" }),
        ],
      });
      expect(edits.map((edit) => edit.disposition)).toEqual(["suggest"]);
    },
  );

  it.each([
    ["i think the build passed.", "i think", "I think"],
    ["Yes, i'm sure it passed.", "i'm", "I'm"],
    ["It passed.\nwe ship tomorrow.", "we ship", "We ship"],
  ])(
    "auto-applies capitalizing a sentence start or I: %s",
    (target, original, replacement) => {
      const edits = resolveWritingEdits({
        ...base,
        target,
        proposals: [
          proposal(original, replacement, { category: "capitalization" }),
        ],
      });
      expect(edits.map((edit) => edit.disposition)).toEqual(["apply"]);
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
    ["value stays true // explanation.", "value", "Value"],
    ["value stays true # explanation.", "value", "Value"],
    ["value stays true -- explanation.", "value", "Value"],
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

  it("still auto-applies an article fix in an unfinished sentence", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "we saw a error",
      proposals: [proposal("a error", "an error")],
    });
    expect(edits.map((edit) => [edit.replacement, edit.disposition])).toEqual([
      ["an", "apply"],
    ]);
  });

  it("only auto-applies when the model reports no semantic impact", () => {
    const edits = resolveWritingEdits({
      ...base,
      target: "We saw a error here.",
      proposals: [
        proposal("a error", "an error", { semanticImpact: "possible" }),
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
        "uh is the build green?",
        "Uh, is the build green?",
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
    ["check the\tthe cache", "Check the cache."],
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
    "keeps the transcript when formatting drops a repeated word: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

  it.each([
    [
      "the not not not i mean not not not not",
      "The not not not, I mean not not not.",
      "negation",
    ],
    ["and and i mean and and and", "And and, I mean and.", "dropped-words"],
  ])(
    "keeps the transcript when a repeat after a correction phrase is cut: %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    [
      "check the the cache before the deploy",
      "Check the the cache before the deploy.",
    ],
    ["eu eu vou rodar de de novo", "Eu eu vou rodar de de novo."],
  ])("accepts formatting that keeps a repeated word: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
  });

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
    ["set value to -.5", "Set value to .5.", "dropped-words"],
    ["set value to .5", "Set value to -.5.", "added-words"],
    ["set value to -,5", "Set value to ,5.", "dropped-words"],
  ])("keeps the sign of a spoken number: %s", (raw, formatted, reason) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    ["set value to .5", "Set value to 5."],
    ["set value to .5", "Set value to 0.5."],
    ["set value to 5", "Set value to .5."],
  ])("keeps a leading decimal point: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({
      ok: false,
      reason: "added-words",
    });
  });

  it.each([
    ["set value to -.5", "Set value to -.5."],
    ["the ratio is .25 or 1.5", "The ratio is .25 or 1.5."],
  ])("accepts leading decimals that keep their form: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
  });

  it.each([
    ["set the limit to 5", "Set the limit to 5%.", "added-words"],
    ["set the budget to 5", "Set the budget to $5.", "added-words"],
    ["set the budget to 5", "Set the budget to €5.", "added-words"],
    ["set the angle to 30", "Set the angle to 30°.", "added-words"],
    ["open issue 42", "Open issue #42.", "added-words"],
    ["call 5 and 6", "Call 5 and +6.", "added-words"],
    ["keep about 5", "Keep about ~5.", "added-words"],
    ["run it 5 times", "Run it 5x times.", "added-words"],
    ["set the cap to 5", "Set the cap to 5k.", "added-words"],
    ["set the limit to 5%", "Set the limit to 5.", "dropped-words"],
    ["set the budget to $5", "Set the budget to 5.", "dropped-words"],
    [
      "set the limit to 5% and the cap to 5",
      "Set the limit to 5% and the cap to 5%.",
      "added-words",
    ],
    [
      "set first limit to 5% and second to 5",
      "Set first limit to 5 and second to 5%.",
      "dropped-words",
    ],
    [
      "set the limit to 5% no wait the limit to 5",
      "Set the limit to 5%.",
      "dropped-words",
    ],
    [
      "set the limit to 5 no wait the limit to 5%",
      "Set the limit to 5%.",
      "dropped-words",
    ],
    ["ship 5 no wait ship 5 today", "Ship 5% today.", "added-words"],
  ])(
    "keeps the symbols spoken next to a number: %s -> %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    ["set the limit to 5%", "Set the limit to 5%."],
    ["set the budget to $5", "Set the budget to $5."],
    ["ship 3 of 5", "Ship 3 of 5."],
    [
      "set the limit to 5% and the cap to 5",
      "Set the limit to 5% and the cap to 5.",
    ],
    ["ship 5 no wait ship 5 today", "Ship 5 today."],
    ["cut 5% no wait cut 5% today", "Cut 5% today."],
  ])("accepts a number that keeps its symbols: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
  });

  it.each([
    ["set range to 1-3", "Set range to 1/3.", "added-words"],
    ["meet at 10 30", "Meet at 10:30.", "added-words"],
    ["pages 4 5", "Pages 4-5.", "added-words"],
    ["items 2 3", "Items 2&3.", "added-words"],
    ["set range to 1-3", "Set range to 1 3.", "dropped-words"],
    ["set range to 1-3", "Set range to 1 - 3.", "dropped-words"],
  ])(
    "keeps what joins two spoken numbers: %s -> %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    ["set range to 1-3", "Set range to 1-3."],
    ["meet at 10:30", "Meet at 10:30."],
    ["ship 2 or 3", "Ship 2 or 3."],
    ["use 5, 6 and 7", "Use 5, 6 and 7."],
  ])("accepts numbers joined as spoken: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
  });

  it.each([
    ["set offset to -5 and limit to 5", "Set offset to 5 and limit to -5."],
    ["move from 3 to -3", "Move from -3 to 3."],
    ["use -2.5 then 2.5 then -2.5", "Use -2.5 then -2.5 then 2.5."],
  ])(
    "keeps the transcript when a sign moves to another equal number: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "reordered",
      });
    },
  );

  it.each([
    ["set offset to 3 and limit to 5", "Set offset to 5 and limit to 3."],
    ["the range is 1 to 10", "The range is 10 to 1."],
    ["call 3 then 3 then 5", "Call 3 then 5 then 3."],
    ["set x to 2.5 and y to 7", "Set x to 7 and y to 2.5."],
    ["3 apples and 5 pears", "5 apples and 3 pears."],
  ])(
    "keeps the transcript when formatting swaps spoken numbers: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "reordered",
      });
    },
  );

  it("accepts equal numbers that keep their signs in order", () => {
    expect(
      validateFormattedTranscript(
        "set offset to -5 and limit to 5",
        "Set offset to -5 and limit to 5.",
      ),
    ).toEqual({ ok: true });
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

  it.each([
    ["quero um, não dois", "Quero, não dois."],
    ["um is the build green?", "Is the build green?"],
    ["quero hum, não dois", "Quero, não dois."],
  ])(
    "keeps um and hum, which can also be the Portuguese for one: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

  it.each([
    ["ah, entendi", "Entendi."],
    ["ahn, deploy agora", "Deploy agora."],
    ["hmm, ship it", "Ship it."],
  ])("keeps interjections that can carry meaning: %s", (raw, formatted) => {
    expect(validateFormattedTranscript(raw, formatted)).toEqual({
      ok: false,
      reason: "dropped-words",
    });
  });

  it.each(["uh", "uhh", "uhm", "umm", "er", "erm"])(
    "keeps the transcript when formatting drops the hesitation sound %s",
    (filler) => {
      expect(
        validateFormattedTranscript(`${filler} ship it`, "Ship it."),
      ).toEqual({ ok: false, reason: "dropped-words" });
      expect(
        validateFormattedTranscript(
          `${filler} ship it`,
          `${filler[0]!.toUpperCase()}${filler.slice(1)}, ship it.`,
        ),
      ).toEqual({ ok: true });
    },
  );

  it("allows self-corrections", () => {
    expect(
      validateFormattedTranscript(
        "uh we should deploy on monday no wait on tuesday",
        "Uh, we should deploy on Tuesday.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "usa o banco de staging quer dizer o banco de produção",
        "Usa o banco de produção.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript("call john actually call mary", "Call Mary."),
    ).toEqual({ ok: true });
  });

  it.each([
    ["uh deploy it now no wait launch it", "Deploy it launch it."],
    ["deploy it now no wait launch it", "Deploy it, launch it."],
    [
      "use the staging database quer dizer o banco de produção",
      "Use o banco de produção.",
    ],
    ["monday no wait tuesday", "Tuesday."],
    ["uh deploy on monday no wait on tuesday", "Deploy on Tuesday."],
  ])(
    "keeps the transcript unless a self-correction drops only the phrase it replaces: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

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

  it.each([
    ["run dash force", "Run -force"],
    ["run dash dash force", "run --force"],
    ["Open config dot json.", "open config.json"],
    ["use the snake underscore case name", "use the snake_case name"],
    ["call camelcase refresh token", "call refreshToken"],
    ["alpha bracket beta bracket", "alpha [beta]"],
    ["call foo paren paren", "call foo()"],
    ["call foo paren", "call foo()"],
    ["map brace brace", "map {}"],
  ])("accepts literal code %s written as %s", (raw, formatted) => {
    expect(
      validateFormattedTranscript(raw, formatted, [], { literalCode: true }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["run dash force", "Run force"],
    ["run dash dash force", "run -force"],
    ["open config dot json", "open config json"],
    ["Open config dot json.", "open config json."],
    ["use a-b dash c", "use a-b c"],
    ["use the snake underscore case name", "use the snake case name"],
    ["run dash force", "Run force-."],
    ["run dash force", "-Run force"],
    ["run dash dash force", "run -force-"],
    ["open config dot json", "open. config json"],
    ["alpha bracket beta", "alpha [beta"],
    ["call foo paren", "call foo("],
    ["map brace key", "map {key"],
    ["alpha bracket beta", "alpha ]beta["],
  ])(
    "rejects literal code %s written as %s, which drops a spoken symbol",
    (raw, formatted) => {
      expect(
        validateFormattedTranscript(raw, formatted, [], { literalCode: true }),
      ).toEqual({ ok: false, reason: "dropped-words" });
    },
  );

  it.each([
    [
      "first add users and groups second remove keys and secrets",
      "1. Add users groups.\n2. Remove keys secrets.",
    ],
    [
      "first add users and groups second remove keys and secrets",
      "1. Add users and groups.\n2. Remove keys secrets.",
    ],
    [
      "first check auth then run tests second deploy",
      "1. Check auth run tests.\n2. Deploy.",
    ],
    [
      "first check auth second run tests and then",
      "1. Check auth.\n2. Run tests.",
    ],
  ])(
    "keeps the transcript when a list drops a connector inside an item: %s -> %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason: "dropped-words",
      });
    },
  );

  it.each([
    [
      "first add users and groups and then second remove keys and secrets",
      "1. Add users and groups.\n2. Remove keys and secrets.",
    ],
    [
      "primeiro verificar o login e depois segundo rodar os testes",
      "1. Verificar o login.\n2. Rodar os testes.",
    ],
  ])(
    "drops only the connectors that lead into the next item: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
    },
  );

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
        "first uh check auth and then second run the tests",
        "1. Check auth.\n2. Run the tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });

  it.each([
    ["one, add users; two, remove keys", "1. Add users.\n2. Remove keys."],
    [
      "one, add users and groups, and then two, remove keys and secrets",
      "1. Add users and groups.\n2. Remove keys and secrets.",
    ],
    [
      "One: check auth. Two: run the tests. Three: deploy.",
      "1. Check auth.\n2. Run the tests.\n3. Deploy.",
    ],
    [
      "um, criar uma tabela e depois dois, rodar os testes",
      "1. Criar uma tabela.\n2. Rodar os testes.",
    ],
    [
      "um, verificar o login; dois, rodar duas migrações; tres, publicar",
      "1. Verificar o login.\n2. Rodar duas migrações.\n3. Publicar.",
    ],
  ])(
    "converts a list enumerated with spoken numbers followed by a pause: %s",
    (raw, formatted) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({ ok: true });
    },
  );

  it.each([
    [
      "one, add users and groups, and then two, remove keys and secrets",
      "1. Add users groups.\n2. Remove keys and secrets.",
      "dropped-words",
    ],
    [
      "one add users two remove keys",
      "1. Add users.\n2. Remove keys.",
      "list-numbers",
    ],
    [
      "One. Add users. Two. Remove keys.",
      "1. Add users.\n2. Remove keys.",
      "list-numbers",
    ],
    [
      "first, add users; two, remove keys",
      "1. Add users.\n2. Remove keys.",
      "list-numbers",
    ],
    [
      "one, add users; second, remove keys",
      "1. Add users.\n2. Remove keys.",
      "list-numbers",
    ],
    [
      "one, add users; two, remove two keys",
      "1. Add users.\n2. Remove keys.",
      "dropped-words",
    ],
  ])(
    "keeps the transcript for a spoken-number list it cannot prove: %s -> %s",
    (raw, formatted, reason) => {
      expect(validateFormattedTranscript(raw, formatted)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it("drops list connectors but never a repeated word", () => {
    expect(
      validateFormattedTranscript(
        "first check auth and then second add the tests",
        "1. Check auth.\n2. Add the tests.",
      ),
    ).toEqual({ ok: true });
    expect(
      validateFormattedTranscript(
        "first check auth and then second add the the tests",
        "1. Check auth.\n2. Add the tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
    expect(
      validateFormattedTranscript(
        "check auth and add tests",
        "Check auth, add tests.",
      ),
    ).toEqual({ ok: false, reason: "dropped-words" });
  });
});
