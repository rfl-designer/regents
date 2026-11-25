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
 * com `scriptExtractions: true`, o teste a pega em `nextExtraction()` e emite os eventos dela.
 */
import type { ModelBrain, ModelEvent, ModelRequest } from "../../src/model/port";

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

export function scriptedBrain(opts: { scriptExtractions?: boolean } = {}) {
  const replies = arrivals("a chamada");
  const extractions = arrivals("a extração");

  const brain: ModelBrain = {
    async *run(request, signal) {
      if (isExtractionRequest(request) && !opts.scriptExtractions) {
        yield { type: "text", text: JSON.stringify({ operacoes: [] }) };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return;
      }
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
      (isExtractionRequest(request) ? extractions : replies).push(run);
      const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      try {
        for (;;) {
          while (queue.length === 0 && !signal.aborted) {
            await Promise.race([new Promise<void>((r) => (notify = r)), aborted]);
          }
          if (signal.aborted) return;
          const item = queue.shift()!;
          yield item.event;
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
  };
}
