/**
 * As datas e horas da tela, todas em pt-BR e no fuso do aparelho. Os formatadores são criados uma
 * vez só (`Intl.DateTimeFormat` é caro de montar).
 */
type When = string | Date;

const HOUR = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const DAY_HOUR = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const FULL_DAY = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const SHORT = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

const toDate = (at: When) => (at instanceof Date ? at : new Date(at));

/** "15:45". */
export const hourMinute = (at: When) => HOUR.format(toDate(at));
/** "20/11". */
export const dayMonth = (at: When) => DAY.format(toDate(at));
/** "20/11, 14:05". */
export const dayMonthHour = (at: When) => DAY_HOUR.format(toDate(at));
/** "20/11 às 14:05". */
export const dayMonthTime = (at: When) => `${dayMonth(at)} às ${hourMinute(at)}`;
/** "20/11/2026". */
export const fullDay = (at: When) => FULL_DAY.format(toDate(at));
/** "qui.". */
export const weekdayShort = (at: When) => WEEKDAY.format(toDate(at));
/** "20/11/2026, 14:05" (data e hora curtas). */
export const dateTimeShort = (at: When) => SHORT.format(toDate(at));
