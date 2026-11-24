/**
 * Contas (Spec, módulo 8; ADR 0005). Uma pasta por Membro debaixo de `root`, onde o
 * próprio Claude Code grava e renova o login. O Shearim nunca lê, copia nem guarda o token:
 * entrega o código colado ao `claude auth login` que espera por ele e guarda só o que
 * `claude auth status --json` diz (e-mail, plano, `loginExpiresAt`).
 *
 * Tudo aqui é do próprio Membro: as rotas não recebem id de ninguém, e os eventos vão
 * só para `{ members: [ele] }`. Nem o Admin vê.
 *
 * Quem paga (#27) marca a Conta "No limite até HH:MM" (`markLimited`) e "Precisa ligar de novo"
 * (`markNeedsRelink`) pelo que a execução pela Conta viu; ligar de novo é o mesmo fluxo de ligar.
 *
 * Fora daqui por enquanto: a religação sem perder a ligação atual e a validade (#35), pushes (#34).
 */
import { lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AccountDto, AccountLinkingDto, AccountStatusDto, SubmitAccountCodeInput } from "@shearim/contracts";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, schema } from "../db/client";
import type { EventHub } from "../events";
import type { Member } from "../members";
import {
  type AuthStatus,
  authLogout,
  authStatus,
  ClaudeMissing,
  type LoginProcess,
  processTracker,
  startLogin,
  type Validation,
  validateAccount,
} from "./claude-cli";

export interface AccountsConfig {
  /** Caminho do binário `claude` (nos testes, o `fake-claude`). */
  claudeBin: string;
  /** Pasta-raiz das Contas, num volume fora do backup. */
  root: string;
  /**
   * Os prazos do encerramento de um `claude -p` (`SIGINT`, espera, `SIGTERM`, espera, `SIGKILL`).
   * Padrão: 10 s e 5 s. Os testes injetam limites curtos.
   */
  stopGrace?: { sigintMs: number; sigtermMs: number };
}

/** O lock que o Claude Code cria (`mkdir`) na pasta da Conta enquanto renova o login. */
const REFRESH_LOCK = ".oauth_refresh.lock";
/** O próprio Claude Code considera o lock velho depois de 60 s sem atualização. */
const STALE_LOCK_MS = 60_000;
/** As pastas de Conta são `<raiz>/<id do Membro>/<uuid do login>`; o resto da raiz não é nosso. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quanto a tela espera pelo código colado (Spec, história 34). */
export const LOGIN_WAIT_MS = 10 * 60_000;
/** Quanto o `auth login` tem para trocar o código depois de recebê-lo. */
const CODE_EXCHANGE_TIMEOUT_MS = 2 * 60_000;

/** O que a tela diz quando a ligação não dá certo. */
export const LINKING_FAILURES = {
  noClaudeCode: "Sua assinatura do Claude não inclui uso pelo Claude Code.",
  orgNotAllowed: "A sua organização no Claude não permite uso pelo Claude Code.",
  onHold: "Sua conta do Claude está suspensa. Veja os detalhes em claude.ai.",
  verification: "O Claude pede que você confirme a sua conta. Confirme em claude.ai e comece de novo.",
  rejected: "A Anthropic não aceitou o login. Comece de novo.",
  badCode: "Esse código não funcionou. Comece de novo e cole o código que a página da Anthropic mostrar.",
  couldNotStart: "Não conseguimos abrir o login da Anthropic. Tente de novo em alguns minutos.",
  missing: "O Claude Code não está instalado neste servidor. Avise quem cuida da Instalação.",
  unavailable: "Não conseguimos conferir a sua Conta agora. Tente de novo em alguns minutos.",
} as const;

function explainValidation(v: Extract<Validation, { ok: false }>): string {
  switch (v.category) {
    case "billing_error":
      return LINKING_FAILURES.noClaudeCode;
    case "oauth_org_not_allowed":
      return LINKING_FAILURES.orgNotAllowed;
    case "account_on_hold":
      return LINKING_FAILURES.onHold;
    case "verification_required":
      return LINKING_FAILURES.verification;
    case "authentication_failed":
      return LINKING_FAILURES.rejected;
  }
  if (v.apiErrorStatus === 402 || v.apiErrorStatus === 403) return LINKING_FAILURES.noClaudeCode;
  if (v.apiErrorStatus === 401) return LINKING_FAILURES.rejected;
  return LINKING_FAILURES.unavailable;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Claude Free",
  pro: "Claude Pro",
  max: "Claude Max",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
};

export function planLabel(subscriptionType: string | null): string {
  if (!subscriptionType) return "Claude";
  return PLAN_NAMES[subscriptionType] ?? `Claude ${subscriptionType[0]!.toUpperCase()}${subscriptionType.slice(1)}`;
}

/** Um "Ligar minha Conta do Claude" em andamento (só em memória: reiniciar o servidor o encerra). */
interface Flow {
  dto: AccountLinkingDto;
  /** A pasta nova deste login. Só vira a pasta da Conta depois de validada. */
  dir: string;
  login?: LoginProcess;
  stopTimer?: () => void;
  status?: AuthStatus;
}

type Env = { Variables: { member: Member } };
type AccountRow = typeof schema.accounts.$inferSelect;

/**
 * Em que pé a Conta está para pagar, agora (Spec, módulo 6, "Quem paga"). `linked` paga; o limite
 * vence sozinho em `until`.
 */
export type AccountStanding =
  | { state: "linked"; configDir: string }
  | { state: "limited"; until: Date }
  | { state: "needs_relink" }
  | { state: "not_linked" };

export function accountStanding(row: AccountRow | undefined | null, now: Date): AccountStanding {
  if (row?.state === "needs_relink") return { state: "needs_relink" };
  if (row?.state !== "linked" || !row.configDir) return { state: "not_linked" };
  if (row.limitedUntil && row.limitedUntil > now) return { state: "limited", until: row.limitedUntil };
  return { state: "linked", configDir: row.configDir };
}

/** O limite sem `resetsAt` (o limite semanal pode sair sem a hora): a Conta é tentada de novo em 1 h. */
export const LIMIT_FALLBACK_MS = 60 * 60_000;

type Result = { ok: true; account: AccountDto } | { ok: false; message: string };

const { accounts } = schema;

export function createAccounts(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  config: AccountsConfig;
  /**
   * A Conta do Membro passou a poder pagar de novo, ou deixou de existir (ligou de novo, desligou):
   * quem espera por ela na fila decide de novo quem paga.
   */
  onChanged?(memberId: string): void;
}) {
  const { db, clock, events, config } = deps;
  /** Quando o "No limite até" de cada Membro vence, "Minha Conta" muda sozinha. */
  const limitTimers = new Map<string, () => void>();
  const procs = processTracker();
  const cli = { clock, procs };
  const flows = new Map<string, Flow>();
  /** Depois do `close()`, nenhum processo novo sobe (ele ficaria órfão). */
  let closed = false;

  async function row(memberId: string) {
    const [found] = await db.select().from(accounts).where(eq(accounts.memberId, memberId));
    return found;
  }

  async function upsert(memberId: string, values: Partial<typeof accounts.$inferInsert>) {
    const now = clock.now();
    await db
      .insert(accounts)
      .values({ memberId, state: "not_linked", ...values, updatedAt: now })
      .onConflictDoUpdate({ target: accounts.memberId, set: { ...values, updatedAt: now } });
  }

  async function dto(memberId: string): Promise<AccountDto> {
    const r = await row(memberId);
    const standing = accountStanding(r, clock.now());
    const who = { email: r?.email ?? "", plan: planLabel(r?.subscriptionType ?? null) };
    const status: AccountStatusDto =
      standing.state === "linked"
        ? { state: "linked", ...who }
        : standing.state === "limited"
          ? { state: "limited", ...who, until: standing.until.toISOString() }
          : standing.state === "needs_relink"
            ? { state: "needs_relink", ...who }
            : { state: "not_linked" };
    return {
      status,
      linking: flows.get(memberId)?.dto ?? null,
      offer: status.state === "not_linked" && !r?.offerDismissedAt,
    };
  }

  async function publish(memberId: string) {
    events.publish({ members: [memberId] }, { type: "account.updated", account: await dto(memberId) });
  }

  const isCurrent = (memberId: string, flow: Flow) => flows.get(memberId) === flow;

  /** Muda o passo do fluxo, se ele ainda é o atual, e avisa as abas do Membro. */
  async function step(memberId: string, flow: Flow, linking: AccountLinkingDto) {
    if (!isCurrent(memberId, flow)) return;
    flow.dto = linking;
    await publish(memberId);
  }

  /** Mata o processo e apaga a pasta nova. Sem `auth logout`: ele revogaria o login no servidor (ADR 0005). */
  async function release(flow: Flow) {
    flow.stopTimer?.();
    flow.login?.kill();
    await flow.login?.exited;
    await rm(flow.dir, { recursive: true, force: true });
  }

  async function end(
    memberId: string,
    flow: Flow,
    linking: Extract<AccountLinkingDto, { state: "failed" | "expired" }>,
  ) {
    if (!isCurrent(memberId, flow)) return;
    flow.dto = linking;
    await release(flow);
    await publish(memberId);
  }
  const fail = (memberId: string, flow: Flow, message: string) => end(memberId, flow, { state: "failed", message });

  /** Algo inesperado num passo vira falha visível, nunca silêncio. */
  const guarded = (memberId: string, flow: Flow, work: () => Promise<void>) => {
    work().catch(() => fail(memberId, flow, LINKING_FAILURES.unavailable));
  };

  async function start(memberId: string): Promise<Result> {
    if ((await row(memberId))?.state === "linked") {
      return { ok: false, message: "A sua Conta já está ligada. Desligue antes de ligar outra." };
    }
    const old = flows.get(memberId);
    const flow: Flow = { dto: { state: "starting" }, dir: join(config.root, memberId, crypto.randomUUID()) };
    flows.set(memberId, flow);
    if (old) await release(old);
    await mkdir(flow.dir, { recursive: true, mode: 0o700 });
    if (closed) return { ok: false, message: "O Shearim está parando. Tente de novo em instantes." };

    try {
      flow.login = startLogin(config.claudeBin, flow.dir, procs);
    } catch (err) {
      await fail(
        memberId,
        flow,
        err instanceof ClaudeMissing ? LINKING_FAILURES.missing : LINKING_FAILURES.couldNotStart,
      );
      return { ok: true, account: await dto(memberId) };
    }
    const login = flow.login;
    const expiresAt = new Date(clock.now().getTime() + LOGIN_WAIT_MS);
    const waiting = () => flow.dto.state === "starting" || flow.dto.state === "waiting_code";
    flow.stopTimer = clock.after(LOGIN_WAIT_MS, () => {
      if (waiting()) void end(memberId, flow, { state: "expired" });
    });
    guarded(memberId, flow, async () => {
      const url = await login.url;
      if (flow.dto.state !== "starting") return;
      if (url) await step(memberId, flow, { state: "waiting_code", url, expiresAt: expiresAt.toISOString() });
      else await fail(memberId, flow, LINKING_FAILURES.couldNotStart);
    });
    // Saiu antes de receber o código: o login não tem mais como terminar.
    login.exited.then(() => {
      if (waiting()) void fail(memberId, flow, LINKING_FAILURES.couldNotStart);
    });

    await publish(memberId);
    return { ok: true, account: await dto(memberId) };
  }

  async function submitCode(memberId: string, code: string): Promise<Result> {
    const flow = flows.get(memberId);
    if (!flow?.login || flow.dto.state !== "waiting_code") {
      return { ok: false, message: "Nenhum login está esperando um código. Comece de novo." };
    }
    const login = flow.login;
    flow.stopTimer?.();
    await step(memberId, flow, { state: "checking" });
    login.submit(code);
    guarded(memberId, flow, async () => {
      const stop = clock.after(CODE_EXCHANGE_TIMEOUT_MS, () => login.kill());
      const exit = await login.exited;
      stop();
      if (!isCurrent(memberId, flow)) return;
      if (exit !== 0) return fail(memberId, flow, LINKING_FAILURES.badCode);

      const status = await authStatus(config.claudeBin, flow.dir, cli);
      if (!isCurrent(memberId, flow)) return;
      if (!status) return fail(memberId, flow, LINKING_FAILURES.rejected);
      flow.status = status;
      if (await linkedToSomeoneElse(memberId, status.email)) return step(memberId, flow, { state: "duplicate" });
      await validateAndLink(memberId, flow);
    });
    return { ok: true, account: await dto(memberId) };
  }

  async function linkedToSomeoneElse(memberId: string, email: string) {
    const [other] = await db
      .select({ memberId: accounts.memberId })
      .from(accounts)
      .where(
        and(
          eq(accounts.state, "linked"),
          ne(accounts.memberId, memberId),
          sql`lower(${accounts.email}) = lower(${email})`,
        ),
      )
      .limit(1);
    return Boolean(other);
  }

  async function validateAndLink(memberId: string, flow: Flow) {
    const v = await validateAccount(config.claudeBin, flow.dir, cli);
    if (!isCurrent(memberId, flow)) return;
    if (!v.ok) return fail(memberId, flow, explainValidation(v));
    const s = flow.status!;
    const now = clock.now();
    await upsert(memberId, {
      state: "linked",
      email: s.email,
      claudeOrgId: s.orgId,
      subscriptionType: s.subscriptionType,
      planTier: s.planTier,
      loginExpiresAt: s.loginExpiresAt,
      configDir: flow.dir,
      linkedAt: now,
      offerDismissedAt: now,
      limitedUntil: null,
    });
    flows.delete(memberId);
    await publish(memberId);
    deps.onChanged?.(memberId);
  }

  async function confirmDuplicate(memberId: string): Promise<Result> {
    const flow = flows.get(memberId);
    if (flow?.dto.state !== "duplicate") return { ok: false, message: "Não há ligação esperando confirmação." };
    await step(memberId, flow, { state: "checking" });
    guarded(memberId, flow, () => validateAndLink(memberId, flow));
    return { ok: true, account: await dto(memberId) };
  }

  /** "Cancelar" no meio, ou fechar o aviso de falha / "Começar de novo". Não mexe na Conta ligada. */
  async function cancel(memberId: string): Promise<AccountDto> {
    const flow = flows.get(memberId);
    if (flow) {
      flows.delete(memberId);
      await release(flow);
      await publish(memberId);
    }
    return dto(memberId);
  }

  /** Desligar: `claude auth logout` e a pasta apagada. Também serve à remoção do Membro (#16). */
  async function unlink(memberId: string): Promise<AccountDto> {
    const r = await row(memberId);
    if (r?.state !== "not_linked" && r?.configDir) {
      await authLogout(config.claudeBin, r.configDir, cli).catch(() => {});
      await rm(r.configDir, { recursive: true, force: true });
      await upsert(memberId, {
        state: "not_linked",
        email: null,
        claudeOrgId: null,
        subscriptionType: null,
        planTier: null,
        loginExpiresAt: null,
        configDir: null,
        linkedAt: null,
        limitedUntil: null,
      });
      await publish(memberId);
      deps.onChanged?.(memberId);
    }
    return dto(memberId);
  }

  /**
   * A execução pela pasta `configDir` bateu no limite: a Conta fica "No limite até `until`" e as
   * próximas execuções nem tentam por ela até lá. Só vale se a Conta ainda usa essa pasta.
   */
  async function markLimited(memberId: string, configDir: string, until: Date | null) {
    // Sem a hora, ou com uma hora que já passou, a Conta volta a ser tentada daqui a 1 h.
    const now = clock.now();
    const at = until && until > now ? until : new Date(now.getTime() + LIMIT_FALLBACK_MS);
    const updated = await db
      .update(accounts)
      .set({ limitedUntil: at, updatedAt: clock.now() })
      .where(and(eq(accounts.memberId, memberId), eq(accounts.configDir, configDir), eq(accounts.state, "linked")))
      .returning({ memberId: accounts.memberId });
    if (updated.length === 0) return;
    await publish(memberId);
    limitTimers.get(memberId)?.();
    const wait = Math.max(0, at.getTime() - clock.now().getTime());
    limitTimers.set(
      memberId,
      clock.after(wait, () => {
        limitTimers.delete(memberId);
        void publish(memberId).catch(() => {});
      }),
    );
  }

  /** O login da pasta `configDir` caiu (`authentication_failed`): "Precisa ligar de novo". */
  async function markNeedsRelink(memberId: string, configDir: string) {
    const updated = await db
      .update(accounts)
      .set({ state: "needs_relink", limitedUntil: null, updatedAt: clock.now() })
      .where(and(eq(accounts.memberId, memberId), eq(accounts.configDir, configDir), eq(accounts.state, "linked")))
      .returning({ memberId: accounts.memberId });
    if (updated.length) await publish(memberId);
  }

  /**
   * Na subida (Spec, módulo 6): apaga as pastas de login que ficaram para trás (um login pela
   * metade quando o servidor parou, ou uma pasta antiga) e, em cada pasta de Conta, o
   * `.oauth_refresh.lock` órfão, só se estiver vazio e tiver mais de 60 s.
   */
  async function recover() {
    const linked = await db.select({ dir: accounts.configDir }).from(accounts).where(isNotNull(accounts.configDir));
    const inUse = new Set(linked.map((r) => resolve(r.dir!)));
    for (const flow of flows.values()) inUse.add(resolve(flow.dir));
    const dirs = async (path: string) =>
      (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(
        (e) => e.isDirectory() && UUID.test(e.name),
      );
    for (const member of await dirs(config.root)) {
      for (const login of await dirs(join(config.root, member.name))) {
        const dir = resolve(config.root, member.name, login.name);
        if (!inUse.has(dir)) await rm(dir, { recursive: true, force: true });
      }
    }
    for (const dir of inUse) await removeStaleLock(join(dir, REFRESH_LOCK));
  }

  const routes = new Hono<Env>();
  const reply = (c: { json: (body: unknown, status?: 200 | 202 | 409) => Response }, r: Result, status: 200 | 202) =>
    r.ok ? c.json(r.account, status) : c.json({ error: "conflict", message: r.message }, 409);

  routes.get("/account", async (c) => c.json(await dto(c.get("member").id)));
  routes.post("/account/not-now", async (c) => {
    const id = c.get("member").id;
    await upsert(id, { offerDismissedAt: clock.now() });
    await publish(id);
    return c.json(await dto(id));
  });
  routes.post("/account/linking", async (c) => reply(c, await start(c.get("member").id), 202));
  routes.post("/account/linking/code", async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<SubmitAccountCodeInput> | null;
    const code = typeof input?.code === "string" ? input.code.trim() : "";
    if (!code)
      return c.json({ error: "invalid_input", message: "Cole o código que a página da Anthropic mostrou." }, 400);
    return reply(c, await submitCode(c.get("member").id, code), 202);
  });
  routes.post("/account/linking/confirm", async (c) => reply(c, await confirmDuplicate(c.get("member").id), 202));
  routes.delete("/account/linking", async (c) => c.json(await cancel(c.get("member").id)));
  routes.delete("/account", async (c) => c.json(await unlink(c.get("member").id)));

  return {
    routes,
    unlink,
    recover,
    markLimited,
    markNeedsRelink,
    /** Encerra os processos do `claude` em andamento (testes e parada do servidor). */
    async close() {
      closed = true;
      for (const cancel of limitTimers.values()) cancel();
      limitTimers.clear();
      const pending = [...flows.values()];
      flows.clear();
      for (const flow of pending) flow.stopTimer?.();
      await procs.killAll();
      // Um login pela metade não sobrevive à parada: a pasta nova dele não serve para nada.
      await Promise.all(pending.map((flow) => rm(flow.dir, { recursive: true, force: true })));
    },
  };
}

/**
 * Apaga o lock se for uma pasta vazia com mais de 60 s. A idade é a do relógio do sistema, o
 * mesmo do `mtime` que o Claude Code grava (o relógio injetável não vale para o disco). O
 * `rmdir` só apaga pasta vazia: se alguém pôs algo dentro no meio-tempo, ela fica.
 */
async function removeStaleLock(lock: string) {
  try {
    const info = await lstat(lock);
    if (!info.isDirectory() || Date.now() - info.mtimeMs <= STALE_LOCK_MS) return;
    await rmdir(lock);
  } catch {
    // não existe, não está vazio ou já foi apagado: fica como está
  }
}
