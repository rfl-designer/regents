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

export const systemClock: Clock = {
  now: () => new Date(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
