/**
 * A configuração do servidor (spec #96): a única peça que lê as variáveis `REGENTS_*` e o nome
 * antigo, `SHEARIM_*`. Cada configuração tem um sufixo (`MAX_PROCESSES`, `IDENTITY`, ...): vale
 * `REGENTS_<sufixo>`; sem ela, vale `SHEARIM_<sufixo>`, com um aviso no log. Com os dois nomes,
 * vale `REGENTS_<sufixo>`, e o log diz que o `SHEARIM_<sufixo>` foi ignorado. Cada aviso sai uma vez.
 */

export type Env = Record<string, string | undefined>;

/** Uma configuração lida: o nome que foi lido (para as mensagens de erro) e o valor, sem espaços. */
export interface Setting {
  name: string;
  value: string;
}

export interface Config {
  /** A configuração do sufixo, ou `undefined` se nenhum dos dois nomes tem valor. */
  read(suffix: string): Setting | undefined;
}

export const PREFIX = "REGENTS";
export const OLD_PREFIX = "SHEARIM";

/** A configuração do ambiente `env`; os avisos do nome antigo vão para `warn`. */
export function configFrom(env: Env, warn: (line: string) => void = () => {}): Config {
  const warned = new Set<string>();
  const once = (suffix: string, line: string) => {
    if (warned.has(suffix)) return;
    warned.add(suffix);
    warn(line);
  };
  return {
    read(suffix) {
      const name = `${PREFIX}_${suffix}`;
      const oldName = `${OLD_PREFIX}_${suffix}`;
      const value = env[name]?.trim();
      const oldValue = env[oldName]?.trim();
      if (value) {
        if (oldValue) once(suffix, `${name} e ${oldName} estão definidas; vale ${name}, e ${oldName} foi ignorada.`);
        return { name, value };
      }
      if (!oldValue) return undefined;
      once(suffix, `${oldName} é o nome antigo; use ${name}`);
      return { name: oldName, value: oldValue };
    },
  };
}
