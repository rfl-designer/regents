import { describe, test } from "@e2e-dev/web";
import type { AgentDto, MeDto, WikiDto } from "@regents/contracts";
import { expect } from "e2e";
import { addMember, as, jsonBody, newPerson } from "../support/people";

/**
 * Wikis na lista de Agentes (#90): cada Membro vê, ao lado das Ferramentas e das Habilidades, as
 * Wikis ligadas ao Agente que ele lê. A restrita só aparece para quem está na lista dela. A Pessoa
 * Dev (Admin) monta tudo pela API; quem olha é o Bruno, no navegador.
 */

/** A Pessoa Dev sobe uma Fonte e sincroniza; espera a versão sair. */
async function sincronizada(baseUrl: string, wiki: WikiDto) {
  const form = new FormData();
  form.append("files", new File(["# Aula 1\n\nO gancho vem primeiro.\n"], "aula-1.md"));
  await as(baseUrl)(`/api/wikis/${wiki.id}/sources`, { method: "POST", body: form });
  await as(baseUrl)(`/api/wikis/${wiki.id}/sync`, { method: "POST" });
  for (let i = 0; i < 100; i++) {
    const lista: WikiDto[] = await as(baseUrl)("/api/wiki-settings");
    if (lista.find((w) => w.id === wiki.id)?.lastSync?.state === "done") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("a Sincronização não terminou");
}

describe("Wikis na lista de Agentes", () => {
  test("o Membro vê na lista de Agentes as Wikis ligadas que ele lê, e não a restrita de fora dele", {
    timeout: 90_000,
  }, async ({ app, screen }) => {
    const api = as(app.baseUrl);
    await api("/api/workspace-key", jsonBody("PUT", { apiKey: "sk-ant-e2e" }));
    const sufixo = Date.now() % 1_000_000;
    const agente = `Social${sufixo}`;
    const curso = `Curso ${sufixo}`;
    const financeiro = `Financeiro ${sufixo}`;
    const criado: AgentDto = await api(
      "/api/agents",
      jsonBody("POST", {
        name: agente,
        description: "Redes sociais.",
        instructions: "Responda curto.",
        model: "claude-haiku-5-5",
      }),
    );
    const doCurso: WikiDto = await api("/api/wikis", jsonBody("POST", { name: curso, description: "O curso." }));
    const doFinanceiro: WikiDto = await api(
      "/api/wikis",
      jsonBody("POST", { name: financeiro, description: "O caixa." }),
    );
    const eu: MeDto = await api("/api/me");
    await api(`/api/wikis/${doFinanceiro.id}/reach`, jsonBody("PUT", { scope: "restricted", memberIds: [eu.id] }));
    for (const w of [doCurso, doFinanceiro]) {
      await sincronizada(app.baseUrl, w);
      await api(`/api/agents/${criado.id}/wikis/${w.id}`, { method: "PUT" });
    }

    const bruno = newPerson("Bruno");
    await addMember(app.baseUrl, bruno);
    await app.open(`/dev/como/${bruno.id}?nome=Bruno`);
    await screen.getByRole("button", "+ Nova DM").tap();
    const naDm = screen.getByRole("list", "Conversar com um Agente").getByRole("listitem").filter({ hasText: agente });
    await expect(naDm).toContainText(`Redes sociais. · Sem Ferramentas · Wikis: ${curso} (O curso.)`);
    await expect(naDm).not.toContainText(financeiro);
  });
});
