/**
 * Pessoas que agem pela API num e2e, ao lado do navegador.
 *
 * O cookie `dev_user` vale para o contexto inteiro do navegador, então uma segunda pessoa
 * no mesmo teste fala com o servidor por `fetch`, com o cookie dela. Sem cookie, quem fala
 * é a "Pessoa Dev", a Admin da execução (a primeira a chegar na Instalação vazia).
 */
import type { JoinRequestAdminDto, JoinRequestDto, MeDto } from "@shearim/contracts";

export interface DevPerson {
  /** `UserProfile.ID` de mentira. Use um único por teste (`Date.now()`): o banco é da execução. */
  id: string;
  name: string;
}

/** Uma pessoa nova, com id único nesta execução. */
export function newPerson(name: string): DevPerson {
  return { id: `${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, name };
}

/** `fetch` como essa pessoa; sem pessoa, como a Pessoa Dev (Admin). */
export function as(baseUrl: string, person?: DevPerson) {
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (person) headers.set("cookie", `dev_user=${encodeURIComponent(JSON.stringify(person))}`);
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`${person?.name ?? "Pessoa Dev"}: ${init.method ?? "GET"} ${path} deu ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  };
}

/** O `init` de um `fetch` com corpo JSON. */
export const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Garante que a Pessoa Dev já abriu a Instalação e é Admin. */
export async function ensureAdmin(baseUrl: string): Promise<MeDto> {
  const me: MeDto = await as(baseUrl)("/api/me");
  if (me.role !== "admin") throw new Error("a Pessoa Dev não é Admin nesta execução");
  return me;
}

/** A pessoa cria o Pedido de entrada dela (a Admin já existe antes). */
export async function requestToJoin(baseUrl: string, person: DevPerson): Promise<JoinRequestDto> {
  await ensureAdmin(baseUrl);
  return as(baseUrl, person)("/api/join-request", { method: "POST" });
}

/** A Pessoa Dev (Admin) aprova o pedido que essa pessoa fez. */
export async function approve(baseUrl: string, person: DevPerson): Promise<void> {
  const pending: JoinRequestAdminDto[] = await as(baseUrl)("/api/join-requests");
  const request = pending.find((r) => r.login === `${person.id}@dev.local`);
  if (!request) throw new Error(`nenhum pedido de ${person.name} esperando`);
  await as(baseUrl)(`/api/join-requests/${request.id}/approve`, { method: "POST" });
}

/** Põe a pessoa como Membro pelo fluxo de verdade: ela pede, a Pessoa Dev aprova. */
export async function addMember(baseUrl: string, person: DevPerson): Promise<MeDto> {
  await requestToJoin(baseUrl, person);
  await approve(baseUrl, person);
  return as(baseUrl, person)("/api/me");
}
