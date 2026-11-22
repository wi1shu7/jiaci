import { afterEach, describe, expect, it, vi } from "vitest";
import { initialGenerateProvider, isGenerateConfigured } from "../src/lib/ai/generate-state";
import { getResponsesConfig, responsesJson } from "../src/lib/ai/responses";

const config = { baseUrl: "https://responses.example.test/v1", apiKey: "test-responses-key", model: "test-model" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Responses 词条生成", () => {
  it("发送 JSON 模式请求并从 message 提取文本", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: '{"core":"中心"}' }] },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(responsesJson(config, "system", "user", 6000)).resolves.toBe('{"core":"中心"}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${config.baseUrl}/responses`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${config.apiKey}` });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: config.model,
      input: [{ role: "system", content: "system" }, { role: "user", content: "user" }],
      text: { format: { type: "json_object" } },
      max_output_tokens: 6000,
      store: false,
    });
  });

  it.each(["max_output_tokens", "length"])("输出预算用完（%s）时保留重试标记和用量", async (reason) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      status: "incomplete",
      incomplete_details: { reason },
      usage: { input_tokens: 1800, input_tokens_details: { cached_tokens: 1200 }, output_tokens: 6000 },
    })));

    await expect(responsesJson(config, "system", "user", 6000)).rejects.toMatchObject({
      truncated: true,
      usage: { input: 600, cachedInput: 1200, output: 6000 },
    });
  });

  it("只有 OpenAI 连接时可首次生成，DeepSeek 已配置时仍优先", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENAI_RESPONSES_BASE_URL", `${config.baseUrl}/`);
    vi.stubEnv("OPENAI_RESPONSES_MODEL", config.model);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(isGenerateConfigured("openai")).toBe(false);
    vi.stubEnv("OPENAI_API_KEY", config.apiKey);
    expect(getResponsesConfig("openai")).toEqual(config);
    expect(initialGenerateProvider()).toBe("openai");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-deepseek-key");
    expect(initialGenerateProvider()).toBe("deepseek");
  });
});
