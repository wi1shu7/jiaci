import { ApiCallError, type Usage } from "./fill";
import type { AiProvider } from "./providers";

type ResponsesConfig = { baseUrl: string; apiKey: string; model: string };

export function getResponsesConfig(provider: AiProvider): ResponsesConfig | null {
  const baseUrl = provider === "openai" ? process.env.OPENAI_RESPONSES_BASE_URL?.trim() : undefined;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    model: process.env.OPENAI_RESPONSES_MODEL?.trim() ?? "",
  };
}

export async function responsesJson(config: ResponsesConfig, system: string, user: string, maxTokens: number): Promise<string> {
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      text: { format: { type: "json_object" } },
      max_output_tokens: maxTokens,
      store: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const safeDetail = (message: string) => message.replaceAll(config.apiKey, "[redacted]").slice(0, 300);
  if (!response.ok) throw new Error(`openai 接口 ${response.status}: ${safeDetail(await response.text())}`);

  const data = await response.json() as {
    status?: string;
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number };
  };
  const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = { input: (data.usage?.input_tokens ?? 0) - cached, cachedInput: cached, output: data.usage?.output_tokens ?? 0 };
  const reason = data.incomplete_details?.reason;
  if (data.status === "incomplete" && (reason === "max_output_tokens" || reason === "length")) {
    throw new ApiCallError("输出被 max_output_tokens 截断", usage, true);
  }
  if (data.status !== "completed") {
    throw new ApiCallError(safeDetail(data.error?.message ?? reason ?? "Responses 接口未完成"), usage);
  }
  const text = data.output?.filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text)
    .join("");
  if (!text) throw new ApiCallError("接口没有返回内容", usage);
  return text;
}
