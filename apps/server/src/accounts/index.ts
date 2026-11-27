/**
 * Contas (Spec, módulo 8; ADR 0005). Uma pasta por Membro debaixo de `root`, onde o
 * próprio Claude Code grava e renova o login. O Regents nunca lê, copia nem guarda o token:
 * entrega o código colado ao `claude auth login` que espera por ele e guarda só o que
 * `claude auth status --json` diz (e-mail, plano, `loginExpiresAt`).
 *
 * Tudo aqui é do próprio Membro: as rotas não recebem id de ninguém, e os eventos vão
 * só para `{ members: [ele] }`. Nem o Admin vê.
 *
 * Quem paga (#27) marca a Conta "No limite até HH:MM" (`markLimited`) e "Precisa ligar de novo"
 * (`markNeedsRelink`) pelo que a execução pela Conta viu.
 *
 * Validade (#35): a data mais cedo em que o login pode cair é `loginExpiresAt` (ou o
 * `credential_expires_at` de uma execução, se vier antes) menos 3 dias. O `auth status` é lido ao
 * ligar e uma vez por dia (`watch`); 3 dias antes da data sai um único aviso por login.
 *
 * Ligar de novo (#35) é o mesmo fluxo, a qualquer momento, numa pasta nova que só entra em uso
 * depois de validada. A pasta antiga sai de uso na hora e é apagada quando o último `claude -p`
 * nela termina (`lease`), sem `auth logout`. Desistir no meio não mexe na Conta.
 *
 * Os pushes da Conta (#34) saem pelos ganchos (`AccountHooks`): a queda (uma vez por queda), a
 * assinatura repetida (ao primeiro dono) e o aviso de vencimento (#35).
 */
import { lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AccountDto,
  AccountLinkingDto,
  AccountStatusDto,
  AccountValidityDto,
  SubmitAccountCodeInput,
} from "@regents/contracts";
import { and, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Clock } from "../clock";
import { type Db, isUuid, schema } from "../db/client";
import type { EventHub } from "../events";
import { keyCoverage } from "../key-budget";
import type { Env } from "../members";
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
const DAY_MS = 24 * 60 * 60_000;
/** O fim real do login pode chegar até 3 dias antes de `loginExpiresAt` (ADR 0005). */
const LOGIN_END_MARGIN_MS = 3 * DAY_MS;
/** O aviso de vencimento sai 3 dias antes da validade. */
export const EXPIRY_WARNING_MS = 3 * DAY_MS;
/**
 * De quanto em quanto tempo o `auth status` de cada Conta Ligada é relido. Também é o horizonte dos
 * prazos marcados no relógio (um `setTimeout` não passa de ~24 dias): o que vence depois, a próxima
 * releitura marca.
 */
export const STATUS_CHECK_MS = DAY_MS;

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
  cannotWrite: "O Regents não consegue gravar a sua Conta neste servidor. Avise quem cuida da Instalação.",
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

/**
 * A validade do login (ADR 0005): a data mais cedo em que ele pode cair. `null` sem data nenhuma
 * (o `auth status` não trouxe `loginExpiresAt` e nenhuma execução trouxe `credential_expires_at`).
 */
export function validityOf(row: AccountRow, now: Date): { until: Date; state: AccountValidityDto["state"] } | null {
  const ends = [row.loginExpiresAt, row.credentialExpiresAt].filter((d): d is Date => d !== null);
  if (ends.length === 0) return null;
  const until = new Date(Math.min(...ends.map((d) => d.getTime())) - LOGIN_END_MARGIN_MS);
  const left = until.getTime() - now.getTime();
  return { until, state: left < 0 ? "any_time" : left <= EXPIRY_WARNING_MS ? "soon" : "ok" };
}

/** O limite sem `resetsAt` (o limite semanal pode sair sem a hora): a Conta é tentada de novo em 1 h. */
export const LIMIT_FALLBACK_MS = 60 * 60_000;

type Result = { ok: true; account: AccountDto } | { ok: false; message: string };

/** Ganchos de domínio da Conta: onde os pushes da Conta (#34) se penduram. Só do próprio Membro. */
export interface AccountHooks {
  /**
   * A Conta Ligada do Membro caiu: chegou ao limite (até `until`) ou o login caiu. Uma vez por
   * queda (outra execução que bate no mesmo limite não chama de novo). Roda depois de gravar.
   */
  accountDropped?(memberId: string, drop: { state: "limited"; until: Date } | { state: "needs_relink" }): void;
  /**
   * `memberId` ligou uma assinatura (o mesmo e-mail) que `owners` já tinham ligada. Roda depois
   * de gravar a ligação nova.
   */
  subscriptionShared?(owners: string[], memberId: string): void;
  /**
   * Faltam 3 dias (ou menos) para a validade do login do Membro (`until`; `state: "any_time"` se ela
   * já passou quando o aviso saiu). Uma vez por login. Roda depois de gravar.
   */
  accountExpiring?(memberId: string, validity: { until: Date; state: "soon" | "any_time" }): void;
}

const { accounts } = schema;

export function createAccounts(deps: {
  db: Db;
  clock: Clock;
  events: EventHub;
  config: AccountsConfig;
  hooks?: AccountHooks;
}) {
  const { db, clock, events, config } = deps;
  /**
   * Quem quer saber que a Conta do Membro passou a poder pagar de novo, ou deixou de existir
   * (ligou de novo, desligou): a fila, para quem espera por ela decidir de novo quem paga.
   */
  const changed: ((memberId: string) => void)[] = [];
  const onChanged = (memberId: string) => {
    for (const fn of changed) fn(memberId);
  };
  /** Quando o "No limite até" de cada Membro vence, "Minha Conta" muda sozinha. */
  const limitTimers = new Map<string, () => void>();
  const procs = processTracker();
  const cli = { clock, procs };
  const flows = new Map<string, Flow>();
  /** Os prazos da validade de cada Membro: o aviso e a passagem para "pode vencer a qualquer momento". */
  const expiryTimers = new Map<string, (() => void)[]>();
  /** Quantos `claude -p` rodam em cada pasta de Conta (`lease`). */
  const leases = new Map<string, number>();
  /** Pastas que saíram de uso ao ligar de novo: apagadas quando o último `claude -p` nelas termina. */
  const retired = new Set<string>();
  let stopWatch: (() => void) | undefined;
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

  async function validityDto(r: AccountRow): Promise<AccountValidityDto | null> {
    const v = validityOf(r, clock.now());
    if (!v) return null;
    // Sem Chave utilizável para nenhum Agente, a fila; com ela para algum, a Chave (`keyCoverage`).
    const afterwards = (await keyCoverage(db, clock.now())) === "none" ? "queue" : "key";
    return { until: v.until.toISOString(), state: v.state, afterwards };
  }

  async function dto(memberId: string): Promise<AccountDto> {
    const r = await row(memberId);
    const standing = accountStanding(r, clock.now());
    const who = { email: r?.email ?? "", plan: planLabel(r?.subscriptionType ?? null) };
    const status: AccountStatusDto =
      standing.state === "linked"
        ? { state: "linked", ...who, validity: await validityDto(r!), extraUsage: r!.extraUsage }
        : standing.state === "limited"
          ? { state: "limited", ...who, until: standing.until.toISOString(), validity: await validityDto(r!) }
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

  /** Um passo que ninguém espera (timer, saída do processo) e falha de novo, com o banco fora, não derruba o processo. */
  const logged = (p: Promise<unknown>) => {
    p.catch((err) => console.error("regents: o fluxo de ligar a Conta falhou", err));
  };
  /** Algo inesperado num passo vira falha visível, nunca silêncio. */
  const guarded = (memberId: string, flow: Flow, work: () => Promise<void>) => {
    logged(work().catch(() => fail(memberId, flow, LINKING_FAILURES.unavailable)));
  };

  /** Ligar, ou ligar de novo: o mesmo fluxo, numa pasta nova. A Conta atual fica como está até validar. */
  async function start(memberId: string): Promise<Result> {
    const old = flows.get(memberId);
    const flow: Flow = { dto: { state: "starting" }, dir: join(config.root, memberId, crypto.randomUUID()) };
    flows.set(memberId, flow);
    if (old) await release(old);
    try {
      await mkdir(flow.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      // O caso conhecido: o volume `contas` criado como root por uma imagem sem /data/contas.
      const uid = process.getuid?.() ?? 1000;
      console.error(
        `regents: a pasta das Contas ${config.root} não deixa o usuário do Regents (uid ${uid}) gravar ` +
          `(${(err as NodeJS.ErrnoException).code}). Dê a pasta a ele: no host, ` +
          `docker compose run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown app ${uid}:${uid} ${config.root}`,
      );
      await fail(memberId, flow, LINKING_FAILURES.cannotWrite);
      return { ok: true, account: await dto(memberId) };
    }
    if (closed) return { ok: false, message: "O Regents está parando. Tente de novo em instantes." };

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
      if (waiting()) logged(end(memberId, flow, { state: "expired" }));
    });
    guarded(memberId, flow, async () => {
      const url = await login.url;
      if (flow.dto.state !== "starting") return;
      if (url) await step(memberId, flow, { state: "waiting_code", url, expiresAt: expiresAt.toISOString() });
      else await fail(memberId, flow, LINKING_FAILURES.couldNotStart);
    });
    // Saiu antes de receber o código: o login não tem mais como terminar.
    login.exited.then(() => {
      if (waiting()) logged(fail(memberId, flow, LINKING_FAILURES.couldNotStart));
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
      // Ligar de novo a mesma assinatura já foi decidido na primeira vez.
      const again = sameSubscription(await row(memberId), status.email);
      if (!again && (await linkedToSomeoneElse(memberId, status.email))) {
        return step(memberId, flow, { state: "duplicate" });
      }
      await validateAndLink(memberId, flow);
    });
    return { ok: true, account: await dto(memberId) };
  }

  /** Quem mais tem esta assinatura (o mesmo e-mail) ligada. */
  async function othersLinkedTo(memberId: string, email: string) {
    const others = await db
      .select({ memberId: accounts.memberId })
      .from(accounts)
      .where(
        and(
          eq(accounts.state, "linked"),
          ne(accounts.memberId, memberId),
          sql`lower(${accounts.email}) = lower(${email})`,
        ),
      );
    return others.map((o) => o.memberId);
  }
  const linkedToSomeoneElse = async (memberId: string, email: string) =>
    (await othersLinkedTo(memberId, email)).length > 0;
  /** A Conta já tem esta assinatura (ligar de novo o mesmo login). */
  const sameSubscription = (r: AccountRow | undefined, email: string) =>
    r?.state !== undefined && r.state !== "not_linked" && r.email?.toLowerCase() === email.toLowerCase();

  async function validateAndLink(memberId: string, flow: Flow) {
    const v = await validateAccount(config.claudeBin, flow.dir, cli);
    if (!isCurrent(memberId, flow)) return;
    if (!v.ok) return fail(memberId, flow, explainValidation(v));
    const s = flow.status!;
    const now = clock.now();
    const before = await row(memberId);
    // Ligar de novo: a pasta antiga sai de uso antes da troca (nenhum `claude -p` novo pega ela) e
    // é apagada quando terminam as execuções dela. Sem `auth logout` (ADR 0005).
    if (before?.configDir && before.configDir !== flow.dir) retire(before.configDir);
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
      credentialExpiresAt: null,
      expiryWarnedAt: null,
      extraUsage: false,
    });
    flows.delete(memberId);
    await publish(memberId);
    onChanged(memberId);
    await schedule(memberId);
    if (sameSubscription(before, s.email)) return;
    const owners = await othersLinkedTo(memberId, s.email);
    if (owners.length) deps.hooks?.subscriptionShared?.(owners, memberId);
  }

  /** Tira a pasta de uso: apagada agora, ou quando o último `claude -p` nela soltar. */
  function retire(configDir: string) {
    const dir = resolve(configDir);
    retired.add(dir);
    if (!leases.get(dir)) void rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  function lease(configDir: string): (() => void) | null {
    const dir = resolve(configDir);
    if (retired.has(dir)) return null;
    leases.set(dir, (leases.get(dir) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (leases.get(dir) ?? 1) - 1;
      if (left > 0) return void leases.set(dir, left);
      leases.delete(dir);
      if (retired.has(dir)) void rm(dir, { recursive: true, force: true }).catch(() => {});
    };
  }

  /** O fim com sucesso de uma execução pela pasta: a validade da credencial e o uso extra. */
  async function runEnded(
    memberId: string,
    configDir: string,
    seen: { credentialExpiresAt?: Date; extraUsage?: boolean },
  ) {
    const r = await row(memberId);
    if (!r || r.configDir !== configDir || r.state !== "linked") return;
    const set: Partial<typeof accounts.$inferInsert> = {};
    if (seen.credentialExpiresAt && seen.credentialExpiresAt.getTime() !== r.credentialExpiresAt?.getTime()) {
      set.credentialExpiresAt = seen.credentialExpiresAt;
    }
    if (seen.extraUsage !== undefined && seen.extraUsage !== r.extraUsage) set.extraUsage = seen.extraUsage;
    if (Object.keys(set).length === 0) return;
    await db
      .update(accounts)
      .set({ ...set, updatedAt: clock.now() })
      .where(and(eq(accounts.memberId, memberId), eq(accounts.configDir, configDir)));
    await publish(memberId);
    if (set.credentialExpiresAt) await schedule(memberId);
  }

  /**
   * Marca no relógio os prazos da validade do Membro: o aviso (3 dias antes) e a passagem para "pode
   * vencer a qualquer momento". Só os que caem antes da próxima releitura diária; os outros, ela marca.
   * O aviso que já devia ter saído sai agora.
   */
  async function schedule(memberId: string) {
    for (const cancel of expiryTimers.get(memberId) ?? []) cancel();
    expiryTimers.delete(memberId);
    const r = await row(memberId);
    if (closed || r?.state !== "linked" || !r.configDir) return;
    const v = validityOf(r, clock.now());
    if (!v) return;
    const dir = r.configDir;
    const now = clock.now().getTime();
    const warnAt = v.until.getTime() - EXPIRY_WARNING_MS;
    const timers: (() => void)[] = [];
    if (!r.expiryWarnedAt) {
      if (warnAt <= now) void warn(memberId, dir);
      else if (warnAt - now <= STATUS_CHECK_MS) timers.push(clock.after(warnAt - now, () => void warn(memberId, dir)));
    }
    const left = v.until.getTime() - now;
    if (left >= 0 && left <= STATUS_CHECK_MS) {
      timers.push(clock.after(left + 1, () => void publish(memberId).catch(() => {})));
    }
    if (timers.length) expiryTimers.set(memberId, timers);
  }

  /** O aviso de vencimento: um só por login (`expiryWarnedAt`), e a "Minha Conta" em destaque. */
  async function warn(memberId: string, configDir: string) {
    try {
      const [warned] = await db
        .update(accounts)
        .set({ expiryWarnedAt: clock.now(), updatedAt: clock.now() })
        .where(
          and(
            eq(accounts.memberId, memberId),
            eq(accounts.configDir, configDir),
            eq(accounts.state, "linked"),
            isNull(accounts.expiryWarnedAt),
          ),
        )
        .returning();
      if (!warned) return;
      await publish(memberId);
      const v = validityOf(warned, clock.now());
      if (v && v.state !== "ok") deps.hooks?.accountExpiring?.(memberId, { until: v.until, state: v.state });
    } catch (err) {
      console.error("regents: o aviso de vencimento da Conta falhou", err);
    }
  }

  /**
   * A releitura diária: o `auth status --json` de cada Conta Ligada (só lê a pasta: sem rede, sem
   * cota, sem o lock de renovação). Atualiza `loginExpiresAt` e o plano, avisa as abas e marca os
   * prazos da validade. Um login revogado o status não percebe: isso fica com a execução.
   */
  async function checkAll() {
    const linked = await db
      .select({ memberId: accounts.memberId, configDir: accounts.configDir })
      .from(accounts)
      .where(and(eq(accounts.state, "linked"), isNotNull(accounts.configDir)));
    for (const { memberId, configDir } of linked) {
      if (closed) return;
      try {
        const status = await authStatus(config.claudeBin, configDir!, cli);
        if (status) {
          await db
            .update(accounts)
            .set({
              loginExpiresAt: status.loginExpiresAt,
              subscriptionType: status.subscriptionType,
              planTier: status.planTier,
              updatedAt: clock.now(),
            })
            .where(and(eq(accounts.memberId, memberId), eq(accounts.configDir, configDir!)));
        }
        await publish(memberId);
        await schedule(memberId);
      } catch (err) {
        console.error("regents: a releitura da validade da Conta falhou", err);
      }
    }
  }

  /** Liga a releitura diária: uma agora (a subida) e depois a cada 24 h do relógio. */
  function watch() {
    const tick = () => {
      if (closed) return;
      stopWatch = clock.after(STATUS_CHECK_MS, tick);
      void checkAll().catch((err) => console.error("regents: a releitura da validade da Conta falhou", err));
    };
    tick();
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

  /** Desligar: `claude auth logout` e a pasta apagada. Também serve à remoção do Membro (#36). */
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
      onChanged(memberId);
      await schedule(memberId);
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
    const ofThisDir = and(
      eq(accounts.memberId, memberId),
      eq(accounts.configDir, configDir),
      eq(accounts.state, "linked"),
    );
    const mark = (where: typeof ofThisDir) =>
      db
        .update(accounts)
        .set({ limitedUntil: at, updatedAt: clock.now() })
        .where(where)
        .returning({ memberId: accounts.memberId });
    // A queda é a passagem de "pode pagar" para "No limite"; outra execução que bate no mesmo
    // limite só acerta a hora.
    const dropped = await mark(and(ofThisDir, or(isNull(accounts.limitedUntil), lte(accounts.limitedUntil, now))));
    const updated = dropped.length ? dropped : await mark(ofThisDir);
    if (updated.length === 0) return;
    await publish(memberId);
    if (dropped.length) deps.hooks?.accountDropped?.(memberId, { state: "limited", until: at });
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
    if (updated.length === 0) return;
    await publish(memberId);
    deps.hooks?.accountDropped?.(memberId, { state: "needs_relink" });
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
        // As pastas de Conta são `<raiz>/<id do Membro>/<uuid do login>`; o resto da raiz não é nosso.
        (e) => e.isDirectory() && isUuid(e.name),
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
    /** Avisa `fn` quando a Conta de um Membro pode pagar de novo ou deixou de existir. */
    onChanged(fn: (memberId: string) => void) {
      changed.push(fn);
    },
    unlink,
    /** Encerra a ligação em andamento, se houver (processo morto, pasta nova apagada). Não mexe na Conta ligada. */
    cancel,
    recover,
    /** A releitura diária do `auth status` e os prazos da validade (a subida chama). */
    watch,
    markLimited,
    markNeedsRelink,
    lease,
    runEnded,
    /** Encerra os processos do `claude` em andamento (testes e parada do servidor). */
    async close() {
      closed = true;
      stopWatch?.();
      for (const cancel of limitTimers.values()) cancel();
      limitTimers.clear();
      for (const cancels of expiryTimers.values()) for (const cancel of cancels) cancel();
      expiryTimers.clear();
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
