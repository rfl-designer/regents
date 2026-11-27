/**
 * A configuração do servidor (spec #96): a única peça que lê as variáveis `REGENTS_*` e o nome
 * antigo, `SHEARIM_*`. Cada configuração tem um sufixo (`MAX_PROCESSES`, `IDENTITY`, ...): vale
 * `REGENTS_<sufixo>`; sem ela, vale `SHEARIM_<sufixo>`, com um aviso no log. Com os dois nomes,
 * vale `REGENTS_<sufixo>`, e o log diz que o `SHEARIM_<sufixo>` foi ignorado. Cada aviso sai uma vez.
 */

export type Env = Record<string, string | undefined>;

/** Os sufixos que o servidor lê. Um sufixo fora desta lista (um erro de digitação) não compila. */
export type Suffix =
  | "IDENTITY"
  | "PROXY_HOST"
  | "PGLITE_DIR"
  | "PG_BIN_DIR"
  | "MASTER_KEY_FILE"
  | "BACKUPS_DIR"
  | "BACKUP_AT"
  | "VAPID_CONTACT"
  | "VERSION"
  | "WEB_DIST"
  | "CLAUDE_BIN"
  | "ACCOUNTS_DIR"
  | "ANTHROPIC_BASE_URL"
  | "GITHUB_URL"
  | "GITHUB_API_URL"
  | "MAX_PER_ACCOUNT"
  | "MAX_ON_KEY"
  | "MAX_PROCESSES"
  | "TOOL_TIMEOUT_S"
  | "TOOL_MAX_TURNS"
  | "APPROVAL_TTL_H"
  | "MEMORY_MODEL"
  | "MEMORY_SUMMARY_CHARS"
  | "WIKI_SOURCE_MAX_MB"
  | "WIKI_SYNC_MAX_TURNS"
  | "WIKI_PART_MAX_CHARS";

/** Uma configuração lida: o nome que foi lido (para as mensagens de erro) e o valor, sem espaços. */
export interface Setting {
  name: string;
  value: string;
}

export interface Config {
  /** A configuração do sufixo, ou `undefined` se nenhum dos dois nomes tem valor. */
  read(suffix: Suffix): Setting | undefined;
}

export const PREFIX = "REGENTS";
export const OLD_PREFIX = "SHEARIM";

/** A configuração do ambiente `env`; os avisos do nome antigo vão para `warn`. */
export function configFrom(env: Env, warn: (line: string) => void = () => {}): Config {
  const warned = new Set<Suffix>();
  const once = (suffix: Suffix, line: string) => {
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

/** Um inteiro maior que zero na configuração `suffix`, ou `undefined` se ela falta; inválido é erro. */
export function positiveInt(config: Config, suffix: Suffix): number | undefined {
  const setting = config.read(suffix);
  if (!setting) return undefined;
  const n = Number(setting.value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${setting.name}=${setting.value} não é um número inteiro maior que zero.`);
  }
  return n;
}

/** Um número maior que zero (aceita fração) na configuração `suffix`, ou `undefined` se ela falta; inválido é erro. */
export function positiveNumber(config: Config, suffix: Suffix): number | undefined {
  const setting = config.read(suffix);
  if (!setting) return undefined;
  const n = Number(setting.value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${setting.name}=${setting.value} não é um número maior que zero.`);
  }
  return n;
}
