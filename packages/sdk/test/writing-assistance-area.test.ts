import { describe, expect, it } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import { BbHttpError, type FetchImplementation } from "../src/response.js";

function sdkWith(
  respond: (request: Request) => Response,
  baseUrl = "https://bb.test",
) {
  const requests: Request[] = [];
  const fetch: FetchImplementation = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return respond(request);
  };
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl,
      fetch,
      runtime: "node",
    }),
  });
  return { sdk, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

describe("writingAssistance SDK area", () => {
  it("uploads a dictation segment as multipart and parses the reply", async () => {
    const { sdk, requests } = sdkWith(
      () =>
        json({
          raw: "first check auth",
          text: "1. Check auth.",
          formatted: true,
        }),
      "https://bb.test/",
    );
    await expect(
      sdk.writingAssistance.transcribeDictationSegment({
        file: new File([audio], "segment.wav", { type: "audio/wav" }),
        context: "Earlier text",
      }),
    ).resolves.toEqual({
      raw: "first check auth",
      text: "1. Check auth.",
      formatted: true,
    });
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "https://bb.test/api/v1/writing-assistance/dictation-segments",
    );
    expect(request?.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/u,
    );
    const form = await request!.formData();
    expect(form.has("durationMs")).toBe(false);
    expect(form.get("context")).toBe("Earlier text");
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Expected an uploaded file");
    expect(file.name).toBe("segment.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it("surfaces the server's budget error with its code", async () => {
    const { sdk } = sdkWith(() =>
      json(
        { code: "budget_exhausted", message: "Daily dictation limit reached" },
        429,
      ),
    );
    const error = await sdk.writingAssistance
      .transcribeDictationSegment({
        file: new File([audio], "segment.wav", { type: "audio/wav" }),
        context: "",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BbHttpError);
    expect(error).toMatchObject({ status: 429, code: "budget_exhausted" });
  });

  it("rejects a malformed reply and an empty file without sending it", async () => {
    const { sdk, requests } = sdkWith(() => json({ text: 42 }));
    await expect(
      sdk.writingAssistance.transcribeDictationSegment({
        file: new File([audio], "segment.wav", { type: "audio/wav" }),
        context: "",
      }),
    ).rejects.toThrow();
    await expect(
      sdk.writingAssistance.transcribeDictationSegment({
        file: new File([], "empty.wav", { type: "audio/wav" }),
        context: "",
      }),
    ).rejects.toThrow("Audio file must not be empty");
    expect(requests).toHaveLength(1);
  });

  it("posts corrections and settings as JSON", async () => {
    const { sdk, requests } = sdkWith((request) =>
      request.url.endsWith("/corrections")
        ? json({ status: "ok", edits: [] })
        : json({ code: "invalid_request", message: "bad mode" }, 400),
    );
    await expect(
      sdk.writingAssistance.correct({
        target: "The user are here.",
        context: "",
        complete: true,
      }),
    ).resolves.toEqual({ status: "ok", edits: [] });
    expect(requests[0]?.url).toBe(
      "https://bb.test/api/v1/writing-assistance/corrections",
    );
    expect(await requests[0]!.json()).toEqual({
      target: "The user are here.",
      context: "",
      complete: true,
    });
    await expect(
      sdk.writingAssistance.updateSettings({ mode: "developer" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(requests[1]?.method).toBe("PUT");
    expect(requests[1]?.url).toBe(
      "https://bb.test/api/v1/writing-assistance/settings",
    );
    expect(await requests[1]!.json()).toEqual({ mode: "developer" });
  });
});
