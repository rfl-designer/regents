/**
 * Relógio injetável: todo caminho testado lê a hora daqui, nunca de `new Date()`,
 * e espera prazos por `after`, nunca por `setTimeout` direto. Assim os testes
 * passam 10 minutos num `clock.advance(...)`.
 */
export interface Clock {
  now(): Date;
  /** Chama `fn` daqui a `ms` milissegundos do relógio. Devolve como cancelar. */
  after(ms: number, fn: () => void): () => void;
}

/** O maior prazo de um `setTimeout` (32 bits, ~24,8 dias): acima dele, o timer dispara na hora. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => new Date(),
  after(ms, fn) {
    // Prazo maior que o do `setTimeout`: uma cadeia de timers até ele.
    let timer: ReturnType<typeof setTimeout>;
    const arm = (left: number) => {
      timer = left > MAX_TIMER_MS ? setTimeout(() => arm(left - MAX_TIMER_MS), MAX_TIMER_MS) : setTimeout(fn, left);
    };
    arm(ms);
    return () => clearTimeout(timer);
  },
};
