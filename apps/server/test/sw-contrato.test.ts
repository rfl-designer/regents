/**
 * O `public/sw.js` do PWA é JavaScript sem bundler: não importa `@shearim/contracts`, então repete
 * o padrão do caminho de uma conversa e o nome da mensagem à janela. Este teste confere que as
 * cópias são as do contrato.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONVERSATION_PATH_PATTERN, SW_NAVIGATE_MESSAGE } from "@shearim/contracts";

const sw = readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8");

test("o service worker usa o caminho de conversa e a mensagem do contrato", () => {
  expect(sw).toContain(`const CONVERSATION_PATH = ${CONVERSATION_PATH_PATTERN.toString()};`);
  expect(sw).toContain(`const NAVIGATE_MESSAGE = ${JSON.stringify(SW_NAVIGATE_MESSAGE)};`);
});
