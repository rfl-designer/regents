/**
 * Dublê da porta de modelo (ADR 0002), para o que a Messages API falsa não sabe dizer: o
 * `api_retry` é do Claude Code (#26), e "progresso no meio do passo" pede que o teste saiba
 * quando o evento foi consumido para só então andar o relógio.
 *
 * Cada `run` do cérebro vira um `ScriptedRun`: o teste emite os eventos normalizados um a um, e
 * `emit` só resolve depois que o Shearim terminou de tratar aquele evento. Sem emitir nada, a
 * chamada fica pendurada até o `signal` abortar (vigia, cancelamento, reinício).
 *
 * Nos testes: `testApp({ keyBrain: cerebro.brain })` troca o cérebro da Chave por este.
 *
 * A extração da Memória (ADR 0013), reconhecida pelo schema (`operacoes`), não entra em
 * `nextRun`/`runs`: sem `scriptExtractions`, ela responde sozinha que não há nada a guardar;
 * com `scriptExtractions: true`, o teste a pega em `nextExtraction()` e emite os eventos dela. No
 * texto emitido, a operação sem `mensagem` cita a última mensagem de pessoa da troca.
 *
 * A Sincronização da Wiki (ADR 0015), reconhecida pela marca no `system` (`isSyncRequest`),
 * também não entra em `nextRun`: sem `scriptSyncs`, cada chamada dela termina sozinha sem escrever
 * nada ("Pronto."); com `scriptSyncs: true`, o teste a pega em `nextSync()`, chama as Ferramentas
 * do rascunho (`run.request.tools!.call(...)`) e emite os eventos dela.
 */
import type { ModelBrain, ModelEvent, ModelRequest } from "../../src/model/port";
import { SYNC_MARKER } from "../../src/wiki/rules";
import { citeLastPersonText } from "./memory-citation";

export interface ScriptedRun {
  request: ModelRequest;
  signal: AbortSignal;
  /** Emite um evento e espera o Shearim tratá-lo. Um evento terminal encerra a chamada. */
  emit(event: ModelEvent): Promise<void>;
}

const TERMINAL = new Set<ModelEvent["type"]>(["done", "failed", "auth_failed", "billing_failed", "limit"]);

/** A extração da Memória, pelo schema da saída estruturada. */
export function isExtractionRequest(request: ModelRequest) {
  const properties = (request.output?.schema as { properties?: object } | undefined)?.properties;
  return Boolean(properties && "operacoes" in properties);
}

/** Uma chamada da Sincronização da Wiki, pela marca das regras da Wiki no `system`. */
export function isSyncRequest(request: ModelRequest) {
  return request.system.includes(SYNC_MARKER);
}

/** Uma fila de chamadas na ordem em que chegaram, com a espera pela próxima. */
function arrivals(what: string) {
  const runs: ScriptedRun[] = [];
  const waiting: ((run: ScriptedRun) => void)[] = [];
  let taken = 0;
  return {
    runs,
    push(run: ScriptedRun) {
      runs.push(run);
      waiting.shift()?.(run);
    },
    next(timeoutMs = 2_000): Promise<ScriptedRun> {
      const i = taken++;
      if (runs[i]) return Promise.resolve(runs[i]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`cérebro roteirizado: ${what} ${i + 1} não chegou`)),
          timeoutMs,
        );
        waiting.push((run) => {
          clearTimeout(timer);
          resolve(run);
        });
      });
    },
  };
}

export function scriptedBrain(opts: { scriptExtractions?: boolean; scriptSyncs?: boolean } = {}) {
  const replies = arrivals("a chamada");
  const extractions = arrivals("a extração");
  const syncs = arrivals("a chamada da Sincronização");

  const brain: ModelBrain = {
    async *run(request, signal) {
      if (isExtractionRequest(request) && !opts.scriptExtractions) {
        yield { type: "text", text: JSON.stringify({ operacoes: [] }) };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return;
      }
      if (isSyncRequest(request) && !opts.scriptSyncs) {
        yield { type: "text", text: "Pronto." };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return;
      }
      const extraction = isExtractionRequest(request);
      const input = request.messages.map((m) => m.content).join("\n");
      const queue: { event: ModelEvent; done: () => void }[] = [];
      let notify: (() => void) | undefined;
      const run: ScriptedRun = {
        request,
        signal,
        emit: (event) =>
          new Promise<void>((done) => {
            if (signal.aborted) return done();
            queue.push({ event, done });
            notify?.();
          }),
      };
      (isExtractionRequest(request) ? extractions : isSyncRequest(request) ? syncs : replies).push(run);
      const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      try {
        for (;;) {
          while (queue.length === 0 && !signal.aborted) {
            await Promise.race([new Promise<void>((r) => (notify = r)), aborted]);
          }
          if (signal.aborted) return;
          const item = queue.shift()!;
          yield extraction && item.event.type === "text"
            ? { ...item.event, text: citeLastPersonText(item.event.text, input) }
            : item.event;
          // Voltou aqui: o Shearim já tratou o evento e pediu o próximo.
          item.done();
          if (TERMINAL.has(item.event.type)) return;
        }
      } finally {
        for (const item of queue.splice(0)) item.done();
      }
    },
  };

  return {
    brain,
    runs: replies.runs,
    /** A próxima chamada ao cérebro (na ordem em que chegaram), esperando até ela chegar. */
    nextRun: replies.next,
    /** As extrações da Memória que chegaram (só com `scriptExtractions`). */
    extractions: extractions.runs,
    /** A próxima extração da Memória (só com `scriptExtractions`). */
    nextExtraction: extractions.next,
    /** As chamadas da Sincronização que chegaram (só com `scriptSyncs`). */
    syncs: syncs.runs,
    /** A próxima chamada da Sincronização (só com `scriptSyncs`). */
    nextSync: syncs.next,
  };
}
