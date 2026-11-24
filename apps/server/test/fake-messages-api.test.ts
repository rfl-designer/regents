import { describe, expect, test } from "bun:test";
import { fakeMessagesApi } from "./harness";

/** O dublê da Chave fala como a Messages API, com a credencial em qualquer um dos dois headers. */
describe("Messages API falsa", () => {
  const pedido = {
    model: "claude-haiku-5-5",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "oi" }],
  };

  test.each([
    ["x-api-key", { "x-api-key": "sk-ant-certa" }],
    ["Authorization: Bearer", { authorization: "Bearer sk-ant-certa" }],
  ])("aceita a chave em %s e responde em SSE", async (_, auth) => {
    const api = await fakeMessagesApi();
    api.acceptKeys("sk-ant-certa");
    api.reply({ text: "Olá!" });

    const res = await fetch(`${api.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...auth },
      body: JSON.stringify(pedido),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const corpo = await res.text();
    expect(corpo).toContain("event: message_start");
    expect(corpo).toContain('"text_delta","text":"Olá!"');
    expect(corpo).toContain("event: message_stop");
    expect(api.requests[0]!.apiKey).toBe("sk-ant-certa");
  });

  test("uma chave fora das aceitas recebe 401 authentication_error", async () => {
    const api = await fakeMessagesApi();
    api.acceptKeys("sk-ant-certa");

    const res = await fetch(`${api.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-errada" },
      body: JSON.stringify(pedido),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });
});
