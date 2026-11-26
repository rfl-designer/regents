/**
 * Importar um `SKILL.md` como Habilidade (spec #74, ticket #76): o Admin manda um `SKILL.md` (ou
 * um `.zip` ou a pasta de uma skill) e o Shearim lê o `name` e a `description` do frontmatter YAML
 * e usa o resto como corpo. Do `.zip` e da pasta, só o `SKILL.md` vira Habilidade: os outros
 * arquivos (scripts, referências, assets) ficam de fora, porque os Agentes do Shearim não executam
 * código, e a resposta os lista.
 */
import { describe, expect, test } from "bun:test";
import type { ImportSkillResultDto, SkillDto } from "@shearim/contracts";
import { zip } from "./fakes/zip";
import { type Person, type TestApp, testApp } from "./harness";

const juliana = { id: "1001", login: "juliana@exemplo.com", name: "Juliana" };
const bruno = { id: "1002", login: "bruno@exemplo.com", name: "Bruno" };

const SKILL_MD = `---
name: Criar carrossel
description: Use quando pedirem um carrossel para o Instagram.
---

# Criar carrossel

1. Comece com um gancho.
2. Uma ideia por slide.
`;

/** Juliana (Admin) manda o arquivo pela tela de importar. */
function importar(t: TestApp, file: File, who: Person = juliana) {
  const form = new FormData();
  form.append("file", file);
  return t.as(who).request("/api/skills/import", { method: "POST", body: form });
}

const md = (text: string, name = "SKILL.md") => new File([text], name, { type: "text/markdown" });

async function admin() {
  const t = await testApp();
  await t.as(juliana).get("/api/me");
  return t;
}

describe("importar um SKILL.md", () => {
  test("nasce a Habilidade com o name, a description e o corpo sem o frontmatter, marcada como importada", async () => {
    const t = await admin();

    const res = await importar(t, md(SKILL_MD));

    expect(res.status).toBe(201);
    const { skill, ignored }: ImportSkillResultDto = await res.json();
    expect(skill.name).toBe("Criar carrossel");
    expect(skill.description).toBe("Use quando pedirem um carrossel para o Instagram.");
    expect(skill.body).toBe("# Criar carrossel\n\n1. Comece com um gancho.\n2. Uma ideia por slide.\n");
    expect(skill.origin).toBe("imported");
    expect(ignored).toEqual([]);
    const lista: SkillDto[] = await (await t.as(juliana).get("/api/skills")).json();
    expect(lista.map((s) => [s.name, s.origin])).toEqual([["Criar carrossel", "imported"]]);
  });

  test("lê o name entre aspas e a description em bloco, e ignora as outras chaves", async () => {
    const t = await admin();
    const yaml = [
      "---",
      'name: "pdf-processing"',
      "description: >",
      "  Extrai texto e tabelas de PDFs.",
      "  Use quando o pedido falar de PDF.",
      "license: Apache-2.0",
      "metadata:",
      "  version: 1.0",
      "---",
      "# PDF",
      "",
    ].join("\r\n");

    const res = await importar(t, md(yaml));

    expect(res.status).toBe(201);
    const { skill }: ImportSkillResultDto = await res.json();
    expect([skill.name, skill.description]).toEqual([
      "pdf-processing",
      "Extrai texto e tabelas de PDFs. Use quando o pedido falar de PDF.",
    ]);
    expect(skill.body).toBe("# PDF\n");
  });
});

const zipFile = (files: Record<string, string>, opts?: { stored?: boolean }) =>
  new File([zip(files, opts)], "criar-carrossel.zip", { type: "application/zip" });

describe("importar um .zip de skill", () => {
  test("só o SKILL.md vira Habilidade, e a resposta lista os arquivos ignorados", async () => {
    const t = await admin();

    const res = await importar(
      t,
      zipFile({
        "criar-carrossel/SKILL.md": SKILL_MD,
        "criar-carrossel/scripts/gerar.py": "print('slide')\n",
        "criar-carrossel/scripts/medir.sh": "echo 1080\n",
        "criar-carrossel/referencia.md": "# Referência\n",
      }),
    );

    expect(res.status).toBe(201);
    const { skill, ignored }: ImportSkillResultDto = await res.json();
    expect(skill.name).toBe("Criar carrossel");
    expect(skill.body).toBe("# Criar carrossel\n\n1. Comece com um gancho.\n2. Uma ideia por slide.\n");
    expect(skill.origin).toBe("imported");
    expect(ignored).toEqual(["referencia.md", "scripts/gerar.py", "scripts/medir.sh"]);
  });

  test("lê o SKILL.md na raiz do .zip, guardado sem compressão", async () => {
    const t = await admin();

    const res = await importar(
      t,
      zipFile({ "SKILL.md": SKILL_MD, "referencia.md": "# Referência\n" }, { stored: true }),
    );

    expect(res.status).toBe(201);
    const { skill, ignored }: ImportSkillResultDto = await res.json();
    expect(skill.description).toBe("Use quando pedirem um carrossel para o Instagram.");
    expect(ignored).toEqual(["referencia.md"]);
  });
});

const nada = async (t: TestApp) => expect(await (await t.as(juliana).get("/api/skills")).json()).toEqual([]);

/**
 * Juliana escolhe a pasta da skill na tela: cada arquivo vai num campo `files`, com o caminho a
 * partir da pasta escolhida no nome. Os de `soNome` vão só com o caminho, sem o conteúdo (como a
 * tela manda o que não é `SKILL.md`).
 */
function importarPasta(t: TestApp, files: Record<string, string>, soNome: string[] = [], who: Person = juliana) {
  const form = new FormData();
  for (const [path, text] of Object.entries(files)) form.append("files", new File([text], path), path);
  for (const path of soNome) form.append("files", path);
  return t.as(who).request("/api/skills/import", { method: "POST", body: form });
}

describe("importar uma pasta de skill", () => {
  test("só o SKILL.md vira Habilidade, e a resposta lista os arquivos ignorados", async () => {
    const t = await admin();

    const res = await importarPasta(
      t,
      {
        "criar-carrossel/SKILL.md": SKILL_MD,
        "criar-carrossel/referencia.md": "# Referência\n",
        "criar-carrossel/.DS_Store": "lixo",
      },
      ["criar-carrossel/scripts/gerar.py", "criar-carrossel/assets/capa.png"],
    );

    expect(res.status).toBe(201);
    const { skill, ignored }: ImportSkillResultDto = await res.json();
    expect(skill.name).toBe("Criar carrossel");
    expect(skill.body).toBe("# Criar carrossel\n\n1. Comece com um gancho.\n2. Uma ideia por slide.\n");
    expect(skill.origin).toBe("imported");
    expect(ignored).toEqual(["assets/capa.png", "referencia.md", "scripts/gerar.py"]);
  });

  test("uma pasta sem SKILL.md falha com o motivo, e nada é criado", async () => {
    const t = await admin();

    const res = await importarPasta(t, { "criar-carrossel/referencia.md": "# Referência\n" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_skill", message: "A pasta não tem um SKILL.md." });
    await nada(t);
  });

  test("uma pasta acima do limite é recusada", async () => {
    const t = await admin();

    const res = await importarPasta(t, {
      "criar-carrossel/SKILL.md": SKILL_MD,
      "criar-carrossel/video.mp4": "x".repeat(5 * 1024 * 1024),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file_too_large", message: "A pasta tem mais de 5 MB." });
    await nada(t);
  });
});

describe("a importação falha com o motivo, e nada é criado", () => {
  test("um SKILL.md sem name", async () => {
    const t = await admin();

    const res = await importar(t, md("---\ndescription: Use quando pedirem um carrossel.\n---\n\n# Carrossel\n"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_skill",
      message: "O frontmatter do SKILL.md não tem o campo name.",
    });
    await nada(t);
  });

  test("um SKILL.md sem description", async () => {
    const t = await admin();

    const res = await importar(t, md("---\nname: Criar carrossel\n---\n\n# Carrossel\n"));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("O frontmatter do SKILL.md não tem o campo description.");
    await nada(t);
  });

  test("um SKILL.md sem frontmatter", async () => {
    const t = await admin();

    const res = await importar(t, md("# Criar carrossel\n\n1. Comece com um gancho.\n"));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(
      "O SKILL.md não tem frontmatter: comece com --- e os campos name e description.",
    );
    await nada(t);
  });

  test("um .zip sem SKILL.md", async () => {
    const t = await admin();

    const res = await importar(t, zipFile({ "criar-carrossel/README.md": "# Leia\n", "scripts/gerar.py": "1\n" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_skill", message: "O .zip não tem um SKILL.md." });
    await nada(t);
  });

  test("um .zip com o SKILL.md sem description", async () => {
    const t = await admin();

    const res = await importar(t, zipFile({ "SKILL.md": "---\nname: Criar carrossel\n---\n\n# Carrossel\n" }));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("O frontmatter do SKILL.md não tem o campo description.");
    await nada(t);
  });

  test("um nome que já existe é recusado como na escrita à mão", async () => {
    const t = await admin();
    await t.as(juliana).post("/api/skills", { name: "criar CARROSSEL", description: "Outra.", body: "# Outra" });

    const res = await importar(t, md(SKILL_MD));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "name_taken",
      message: "Já existe uma Habilidade chamada Criar carrossel.",
    });
    const lista: SkillDto[] = await (await t.as(juliana).get("/api/skills")).json();
    expect(lista.map((s) => s.name)).toEqual(["criar CARROSSEL"]);
  });

  test("um arquivo maior que o limite", async () => {
    const t = await admin();

    const res = await importar(t, md(`${SKILL_MD}${"x".repeat(5 * 1024 * 1024)}`));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file_too_large", message: "O arquivo tem mais de 5 MB." });
    await nada(t);
  });

  test("só o Admin importa", async () => {
    const t = await admin();
    await t.addMember(bruno, { by: juliana });

    const res = await importar(t, md(SKILL_MD), bruno);

    expect(res.status).toBe(403);
    await nada(t);
  });
});

describe("a Habilidade importada é como uma escrita à mão", () => {
  test("se edita, ativa num Agente e apaga", async () => {
    const t = await admin();
    const agente = await t.as(juliana).post("/api/agents", {
      name: "Social",
      photo: null,
      description: "O Social.",
      instructions: "Você é o Social.",
      model: "claude-sonnet-5-5",
    });
    const { id: agentId } = await agente.json();
    const { skill }: ImportSkillResultDto = await (await importar(t, md(SKILL_MD))).json();

    const editada = await t.as(juliana).patch(`/api/skills/${skill.id}`, { description: "Quando pedirem carrossel." });
    expect(editada.status).toBe(200);
    expect(((await editada.json()) as SkillDto).description).toBe("Quando pedirem carrossel.");

    expect((await t.as(juliana).put(`/api/agents/${agentId}/skills/${skill.id}`)).status).toBe(200);
    const vista: SkillDto = await (await t.as(juliana).get(`/api/skills/${skill.id}`)).json();
    expect(vista.agents.map((a) => a.name)).toEqual(["Social"]);
    expect(vista.origin).toBe("imported");

    expect((await t.as(juliana).delete(`/api/skills/${skill.id}`)).status).toBe(204);
    expect(await (await t.as(juliana).get(`/api/agents/${agentId}/skills`)).json()).toEqual([]);
  });
});
