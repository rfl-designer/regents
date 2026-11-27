import { describe, expect, test } from "bun:test";
import type { ChannelDto, DeviceDto, DmDto, MeDto, MessageDto, PushKeyDto } from "@regents/contracts";
import { eventually, type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "2002", login: "bruno@exemplo.com", name: "Bruno" };
const carla = { id: "3003", login: "carla@exemplo.com", name: "Carla" };

/** Juliana vira Admin; as outras pessoas, Membros. Devolve o `MeDto` de cada uma, pelo nome. */
async function workspace(t: TestApp, ...people: Person[]) {
  const me: Record<string, MeDto> = { Juliana: await (await t.as(juliana).get("/api/me")).json() };
  for (const p of people) me[p.name!] = await t.addMember(p, { by: juliana });
  return me;
}

async function canal(t: TestApp, name: string, who: Person = juliana): Promise<ChannelDto> {
  const res = await t.as(who).post("/api/channels", { name, kind: "public" });
  expect(res.status).toBe(201);
  return res.json();
}

async function enviar(t: TestApp, who: Person, conversationId: string, body: string): Promise<MessageDto> {
  const res = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { body });
  expect(res.status).toBe(201);
  return res.json();
}

/** O `Topic` de uma conversa: o UUID sem hífens (32 caracteres, o limite do header). */
const topicOf = (conversationId: string) => conversationId.replaceAll("-", "");

describe("push de Menção", () => {
  test("a Menção a um Membro num Canal chega ao aparelho dele no formato do Declarative Web Push", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    await t.as(bruno).post(`/api/channels/${vendas.id}/join`);
    const celular = await t.pushDevice(bruno);

    await enviar(t, juliana, vendas.id, `@${me.Bruno!.handle} fecha a proposta hoje?`);

    const push = await celular.next();
    expect(push.payload).toEqual({
      web_push: 8030,
      notification: {
        title: "#vendas · Juliana",
        body: `@${me.Bruno!.handle} fecha a proposta hoje?`,
        navigate: expect.stringMatching(new RegExp(`/c/${vendas.id}$`)),
        tag: vendas.id,
        lang: "pt-BR",
      },
      // O badge é o total de não-lidas dele (de quem participa), esta inclusive.
      app_badge: 1,
    });
    expect(push.payload.notification.navigate).toStartWith("http");
    expect(push.topic).toBe(topicOf(vendas.id));
    expect(push.urgency).toBe("high");
    expect(push.ttl).toBe(86_400);
  });
});

async function abrirDm(t: TestApp, who: Person, memberIds: string[]): Promise<DmDto> {
  const res = await t.as(who).post("/api/dms", { memberIds });
  expect(res.status).toBe(201);
  return res.json();
}

describe("push de DM", () => {
  test("toda mensagem numa DM chega à outra pessoa, com o nome de quem escreveu no título", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const daJuliana = await t.pushDevice(juliana);
    const doBruno = await t.pushDevice(bruno);

    await enviar(t, juliana, dm.id, "Bruno, viu o contrato?");

    const push = await doBruno.next();
    expect(push.payload.notification).toMatchObject({ title: "Juliana", body: "Bruno, viu o contrato?", tag: dm.id });
    expect(push.topic).toBe(topicOf(dm.id));
    expect(push.urgency).toBe("high");
    expect(push.ttl).toBe(86_400);

    // Quem escreveu não recebe: a resposta do Bruno é o próximo push que chega à Juliana.
    await enviar(t, bruno, dm.id, "Vi sim.");
    expect((await daJuliana.next()).payload.notification).toMatchObject({ title: "Bruno", body: "Vi sim." });
  });

  test("numa DM em grupo, o título diz com quem mais é a conversa", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const grupo = await abrirDm(t, juliana, [me.Bruno!.id, me.Carla!.id]);
    const doBruno = await t.pushDevice(bruno);
    const daCarla = await t.pushDevice(carla);

    await enviar(t, juliana, grupo.id, "Reunião às 15h.");

    expect((await doBruno.next()).payload.notification.title).toBe("Juliana em DM com Carla");
    expect((await daCarla.next()).payload.notification.title).toBe("Juliana em DM com Bruno");
  });
});

describe("o que não gera push", () => {
  test("mensagem comum de Canal não gera push; a Menção que vem depois é o primeiro que chega", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    await t.as(bruno).post(`/api/channels/${vendas.id}/join`);
    const doBruno = await t.pushDevice(bruno);

    await enviar(t, juliana, vendas.id, "bom dia, time");
    await enviar(t, juliana, vendas.id, `@${me.Bruno!.handle} e a proposta?`);

    expect((await doBruno.next()).payload.notification.body).toBe(`@${me.Bruno!.handle} e a proposta?`);
  });

  test("quem se menciona não recebe push de si mesmo", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    const daJuliana = await t.pushDevice(juliana);

    await enviar(t, juliana, vendas.id, `nota para mim: @${me.Juliana!.handle} ligar amanhã`);
    await enviar(t, bruno, vendas.id, `@${me.Juliana!.handle} liguei eu`);

    expect((await daJuliana.next()).payload.notification.title).toBe("#vendas · Bruno");
  });
});

/** Diz ao servidor qual conversa essa conexão tem aberta e visível. */
async function aVista(t: TestApp, who: Person, connectionId: string, conversationId: string | null) {
  const res = await t.as(who).put("/api/presence", { connectionId, conversationId });
  expect(res.status).toBe(204);
}

describe("Presença: o push cala com a conversa à vista", () => {
  test("com a conversa aberta e visível num aparelho, o push dela não sai para nenhum aparelho", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    const celular = await t.pushDevice(bruno);
    const notebook = await t.socket(bruno, "notebook do Bruno");
    await aVista(t, bruno, notebook.connectionId, vendas.id);

    await enviar(t, juliana, vendas.id, `@${me.Bruno!.handle} já viu?`);
    await aVista(t, bruno, notebook.connectionId, null);
    await enviar(t, juliana, vendas.id, `@${me.Bruno!.handle} e agora?`);

    expect((await celular.next()).payload.notification.body).toBe(`@${me.Bruno!.handle} e agora?`);
  });

  test("outra conversa à vista não cala o push desta", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    const geral = ((await (await t.as(juliana).get("/api/channels")).json()) as ChannelDto[]).find(
      (c) => c.name === "geral",
    )!;
    const celular = await t.pushDevice(bruno);
    const aba = await t.socket(bruno);
    await aVista(t, bruno, aba.connectionId, geral.id);

    await enviar(t, juliana, vendas.id, `@${me.Bruno!.handle} aqui`);

    expect((await celular.next()).payload.notification.title).toBe("#vendas · Juliana");
  });

  test("a conexão que cai leva a Presença junto: o push volta a sair", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    const aba = await t.socket(bruno);
    await aVista(t, bruno, aba.connectionId, dm.id);

    await aba.close();
    // O servidor fica sabendo do fechamento logo depois; a mensagem sai quando a Presença sumiu.
    await eventually("a Presença sumir com a conexão", async () => {
      const res = await t.as(bruno).put("/api/presence", { connectionId: aba.connectionId, conversationId: dm.id });
      return res.status === 404;
    });
    await enviar(t, juliana, dm.id, "ainda aí?");

    expect((await celular.next()).payload.notification.body).toBe("ainda aí?");
  });

  test("ninguém diz a Presença pela conexão de outra pessoa, nem numa conversa que não vê", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const doBruno = await t.socket(bruno);
    const daCarla = await t.socket(carla);

    expect(
      (await t.as(carla).put("/api/presence", { connectionId: doBruno.connectionId, conversationId: null })).status,
    ).toBe(404);
    expect(
      (await t.as(carla).put("/api/presence", { connectionId: daCarla.connectionId, conversationId: dm.id })).status,
    ).toBe(404);
  });
});

describe("as notificações de uma conversa se substituem", () => {
  test('a rajada num Canal vira "n novas em #canal" com o trecho da última, sempre na mesma tag', async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const vendas = await canal(t, "vendas");
    const celular = await t.pushDevice(bruno);
    const b = `@${me.Bruno!.handle}`;

    await enviar(t, juliana, vendas.id, `${b} proposta?`);
    await enviar(t, carla, vendas.id, `${b} cliente ligou`);
    await enviar(t, juliana, vendas.id, `${b} urgente`);

    const pushes = [await celular.next(), await celular.next(), await celular.next()];
    expect(pushes.map((p) => [p.payload.notification.title, p.payload.notification.body])).toEqual([
      ["#vendas · Juliana", `${b} proposta?`],
      ["2 novas em #vendas", `Carla: ${b} cliente ligou`],
      ["3 novas em #vendas", `Juliana: ${b} urgente`],
    ]);
    expect(new Set(pushes.map((p) => p.tag))).toEqual(new Set([vendas.id]));
    expect(new Set(pushes.map((p) => p.topic))).toEqual(new Set([topicOf(vendas.id)]));
  });

  test("numa DM, a contagem diz de quem são", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);

    await enviar(t, juliana, dm.id, "oi");
    await enviar(t, juliana, dm.id, "tá aí?");

    await celular.next();
    expect((await celular.next()).payload.notification).toMatchObject({
      title: "2 novas de Juliana",
      body: "Juliana: tá aí?",
    });
  });

  test("cada conversa conta à parte, e abrir a conversa recomeça a contagem dela", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    const aba = await t.socket(bruno);
    const b = `@${me.Bruno!.handle}`;

    await enviar(t, juliana, vendas.id, `${b} um`);
    await enviar(t, juliana, dm.id, "na DM");
    await enviar(t, juliana, vendas.id, `${b} dois`);
    await aVista(t, bruno, aba.connectionId, vendas.id);
    await aVista(t, bruno, aba.connectionId, null);
    await enviar(t, juliana, vendas.id, `${b} três`);

    const titles = [];
    for (let i = 0; i < 4; i++) titles.push((await celular.next()).payload.notification.title);
    expect(titles).toEqual(["#vendas · Juliana", "Juliana", "2 novas em #vendas", "#vendas · Juliana"]);
  });
});

describe("o badge", () => {
  test("o app_badge leva o total de não-lidas de quem recebe, de todas as conversas", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const vendas = await canal(t, "vendas");
    await t.as(bruno).post(`/api/channels/${vendas.id}/join`);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);

    await enviar(t, juliana, vendas.id, "sem menção, mas conta como não-lida");
    await enviar(t, juliana, dm.id, "na DM");

    expect((await celular.next()).payload.app_badge).toBe(2);
  });
});

describe("o texto da notificação", () => {
  test("o corpo é um trecho de cerca de 140 caracteres, numa linha", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    const longa = `Resumo da reunião:\n\n${"o cliente quer desconto e prazo maior. ".repeat(10)}`;

    await enviar(t, juliana, dm.id, longa);

    const body = (await celular.next()).payload.notification.body!;
    expect(body).toStartWith("Resumo da reunião: o cliente quer desconto");
    expect(body).not.toContain("\n");
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body.length).toBeGreaterThan(120);
    expect(body).toEndWith("…");
  });
});

async function aparelhosDe(t: TestApp, who: Person): Promise<DeviceDto[]> {
  return (await t.as(who).get("/api/devices")).json();
}

describe("inscrição morta", () => {
  for (const status of [404, 410]) {
    test(`com ${status} do push service, a inscrição some e o aparelho fica com "parou em"`, async () => {
      const t = await testApp();
      const me = await workspace(t, bruno);
      const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
      const celular = await t.pushDevice(bruno);
      const notebook = await t.pushDevice(bruno);
      celular.respond(status);
      t.clock.set("2026-11-24T15:30:00.000Z");

      await enviar(t, juliana, dm.id, "primeira");
      expect((await celular.next()).status).toBe(status);
      expect((await notebook.next()).status).toBe(201);

      // O coletor registra o push antes de o servidor ler a resposta: espere ele anotar.
      const aparelhos = await eventually("o servidor anotar as respostas", async () => {
        const list = await aparelhosDe(t, bruno);
        return list.every((d) => d.lastPushAt || d.pushStoppedAt) && list;
      });
      expect(aparelhos.find((d) => d.id === celular.deviceId)).toMatchObject({
        pushing: false,
        pushStoppedAt: "2026-11-24T15:30:00.000Z",
      });
      expect(aparelhos.find((d) => d.id === notebook.deviceId)).toMatchObject({
        pushing: true,
        pushStoppedAt: null,
        lastPushAt: "2026-11-24T15:30:00.000Z",
      });

      // O celular não recebe mais tentativas; o notebook segue recebendo.
      await enviar(t, juliana, dm.id, "segunda");
      expect((await notebook.next()).payload.notification.body).toBe("Juliana: segunda");
      expect(t.push.deliveries.filter((d) => d.endpoint === celular.subscription.endpoint)).toHaveLength(1);
    });
  }

  test('ligar o push de novo no aparelho tira o "parou em"', async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);
    celular.respond(410);
    await enviar(t, juliana, dm.id, "primeira");
    await eventually("o aparelho parar", async () => (await aparelhosDe(t, bruno))[0]?.pushStoppedAt);

    const religado = await t.pushDevice(bruno, celular.deviceId);
    await enviar(t, juliana, dm.id, "segunda");

    expect((await religado.next()).status).toBe(201);
    expect(await aparelhosDe(t, bruno)).toEqual([
      expect.objectContaining({ id: celular.deviceId, pushing: true, pushStoppedAt: null }),
    ]);
  });
});

describe("par VAPID e inscrições", () => {
  test("a chave pública VAPID é uma chave P-256 e continua a mesma depois de reiniciar", async () => {
    const t = await testApp();
    await workspace(t);

    const { publicKey }: PushKeyDto = await (await t.as(juliana).get("/api/push/key")).json();
    await t.restart();
    const depois: PushKeyDto = await (await t.as(juliana).get("/api/push/key")).json();

    const bytes = Buffer.from(publicKey, "base64url");
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(depois.publicKey).toBe(publicKey);
  });

  test("o push assinado com o par guardado chega depois do reinício", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno);
    const dm = await abrirDm(t, juliana, [me.Bruno!.id]);
    const celular = await t.pushDevice(bruno);

    await t.restart();
    await enviar(t, juliana, dm.id, "depois do reinício");

    expect((await celular.next()).payload.notification.body).toBe("depois do reinício");
  });

  test("a inscrição precisa de um endpoint https e das duas chaves do navegador", async () => {
    const t = await testApp();
    await workspace(t);
    const ok = t.push.subscription();
    const aparelho = crypto.randomUUID();
    const put = (body: unknown, id: string = aparelho) => t.as(juliana).put(`/api/push/subscriptions/${id}`, body);

    expect((await put({ ...ok, endpoint: "http://push.exemplo.com/x" })).status).toBe(400);
    expect((await put({ endpoint: ok.endpoint, keys: { p256dh: ok.keys.p256dh } })).status).toBe(400);
    expect((await put(ok, "nao-e-um-uuid")).status).toBe(400);
    expect((await put(ok)).status).toBe(204);
    expect((await put(ok)).status).toBe(204);
  });

  test("o mesmo navegador inscrito por outra pessoa deixa de receber os pushes da primeira", async () => {
    const t = await testApp();
    const me = await workspace(t, bruno, carla);
    const dmBruno = await abrirDm(t, juliana, [me.Bruno!.id]);
    const dmCarla = await abrirDm(t, juliana, [me.Carla!.id]);
    const compartilhado = await t.pushDevice(bruno);
    const res = await t.as(carla).put(`/api/push/subscriptions/${crypto.randomUUID()}`, compartilhado.subscription);
    expect(res.status).toBe(204);

    await enviar(t, juliana, dmBruno.id, "para o Bruno");
    await enviar(t, juliana, dmCarla.id, "para a Carla");

    expect((await compartilhado.next()).payload.notification.body).toBe("para a Carla");
  });
});
