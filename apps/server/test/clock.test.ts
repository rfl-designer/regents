/**
 * O relógio do sistema (`systemClock`): um prazo maior que o de um `setTimeout` (32 bits, ~24,8
 * dias) não dispara na hora; vira uma cadeia de timers até o prazo pedido.
 */
import { afterEach, expect, test } from "bun:test";
import { systemClock } from "../src/clock";

const MAX = 2 ** 31 - 1;
const DIA = 24 * 60 * 60_000;
const original = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };

afterEach(() => {
  globalThis.setTimeout = original.set;
  globalThis.clearTimeout = original.clear;
});

/** Troca o `setTimeout` por um que só grava os timers, para dispará-los à mão. */
function timersGravados() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length - 1;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    if (timers[id]) timers[id].cleared = true;
  }) as unknown as typeof clearTimeout;
  return timers;
}

test("um prazo de 30 dias só chama a função depois dos 30 dias, em timers que cabem em 32 bits", () => {
  const timers = timersGravados();
  let chamou = false;
  systemClock.after(30 * DIA, () => {
    chamou = true;
  });

  expect(timers.map((t) => t.ms)).toEqual([MAX]);
  timers[0]!.fn();
  expect(chamou).toBe(false);
  expect(timers.map((t) => t.ms)).toEqual([MAX, 30 * DIA - MAX]);
  timers[1]!.fn();
  expect(chamou).toBe(true);
});

test("cancelar no meio da cadeia cancela o timer que está armado", () => {
  const timers = timersGravados();
  const cancelar = systemClock.after(30 * DIA, () => {});
  timers[0]!.fn();
  cancelar();
  expect(timers[1]!.cleared).toBe(true);
});

test("um prazo curto continua sendo um timer só", () => {
  const timers = timersGravados();
  systemClock.after(5_000, () => {});
  expect(timers.map((t) => t.ms)).toEqual([5_000]);
});
