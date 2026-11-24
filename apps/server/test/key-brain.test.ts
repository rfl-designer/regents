/**
 * O pedido de saída estruturada pela Chave (ADR 0009): o mesmo `outputSchema` do cérebro da
 * Conta, como `output_config.format` da Messages API, com a decisão de volta em `done.structured`.
 */
import { describe, expect, test } from "bun:test";
import { keyBrain } from "../src/model/key";
import type { ModelEvent, ModelRequest } from "../src/model/port";
import { fakeMessagesApi } from "./harness";

const schema = { type: "object", properties: { decision: { enum: ["responder", "delegar", "nenhum"] } } };

async function run(baseURL: string, extra: Partial<ModelRequest> = {}) {
  const events: ModelEvent[] = [];
  const request: ModelRequest = {
    model: "claude-haiku-5-5",
    system: "Você é a Sophya.",
    messages: [{ role: "user", content: "Juliana (pessoa): bom dia" }],
    payer: { kind: "key", apiKey: "sk-ant-api03-chave" },
    ...extra,
  };
  for await (const e of keyBrain({ baseURL }).run(request, new AbortController().signal)) events.push(e);
  return events;
}

describe("saída estruturada pela Chave", () => {
  test("vai como output_config.format e volta em done.structured", async () => {
    const api = await fakeMessagesApi();
    api.reply({ text: '{"decision":"nenhum"}' });

    const events = await run(api.url, { outputSchema: schema });

    expect(api.requests[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(events.at(-1)).toMatchObject({ type: "done", structured: { decision: "nenhum" } });
  });

  test("sem pedido, nada muda", async () => {
    const api = await fakeMessagesApi();
    api.reply({ text: "Bom dia!" });

    const events = await run(api.url);

    expect(api.requests[0]!.body.output_config).toBeUndefined();
    expect(events.at(-1)).not.toHaveProperty("structured");
  });

  test("um texto que não é JSON é falha que vale nova tentativa", async () => {
    const api = await fakeMessagesApi();
    api.reply({ text: "acho que nenhum" });

    const events = await run(api.url, { outputSchema: schema });

    expect(events.at(-1)).toEqual({
      type: "failed",
      reason: "o modelo não devolveu a decisão no formato pedido",
      retryable: true,
    });
  });
});
