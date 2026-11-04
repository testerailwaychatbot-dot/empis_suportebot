import test from "node:test";
import assert from "node:assert/strict";
import { analisarDataAgendamento as a, normalizarHorario as h } from "../datas.js";

// 04/11/2026 12:00 em Brasília (15:00 UTC)
const MEIO_DIA = new Date("2026-11-04T15:00:00Z");
// 04/11/2026 22:30 em Brasília = 05/11 01:30 UTC (caso do bug)
const NOITE = new Date("2026-11-05T01:30:00Z");
// 04/11/2026 00:10 em Brasília = 03:10 UTC
const MADRUGADA = new Date("2026-11-04T03:10:00Z");

test("amanhã é válido ao meio-dia", () => {
  assert.deepEqual(a("05/11/2026", MEIO_DIA), { ok: true, data: "05/11/2026" });
});
test("BUG: amanhã é válido depois das 21h de Brasília (servidor em UTC)", () => {
  assert.deepEqual(a("05/11/2026", NOITE), { ok: true, data: "05/11/2026" });
  assert.deepEqual(a("06/11/2026", NOITE), { ok: true, data: "06/11/2026" });
});
test("hoje é rejeitado como muito próximo, em qualquer horário", () => {
  assert.equal(a("04/11/2026", MEIO_DIA).motivo, "proxima");
  assert.equal(a("04/11/2026", NOITE).motivo, "proxima");
  assert.equal(a("04/11/2026", MADRUGADA).motivo, "proxima");
  assert.equal(a("05/11/2026", NOITE).ok, true);
});
test("data passada", () => {
  assert.equal(a("03/11/2026", MEIO_DIA).motivo, "passado");
  assert.equal(a("01/01/2020", MEIO_DIA).motivo, "passado");
});
test("separadores e dia/mês com um dígito", () => {
  for (const v of ["5-11-2026", "05.11.2026", "5/11/2026", " 05 / 11 / 2026 ", "05/11/2026\n", "05/11/2026."]) {
    assert.deepEqual(a(v, MEIO_DIA), { ok: true, data: "05/11/2026" }, v);
  }
});
test("ano com 2 dígitos, sem ano e compacto", () => {
  assert.equal(a("05/11/26", MEIO_DIA).data, "05/11/2026");
  assert.equal(a("20/11", MEIO_DIA).data, "20/11/2026");
  assert.equal(a("03/11", MEIO_DIA).data, "03/11/2027"); // já passou: próximo ano
  assert.equal(a("05112026", MEIO_DIA).data, "05/11/2026");
  assert.equal(a("051126", MEIO_DIA).data, "05/11/2026");
});
test("data dentro de uma frase", () => {
  assert.equal(a("dia 10/11/2026 por favor", MEIO_DIA).data, "10/11/2026");
});
test("caracteres invisíveis e dígitos largos", () => {
  assert.equal(a("\u200E10/11/2026\u200F", MEIO_DIA).data, "10/11/2026");
  assert.equal(a("１０/１１/２０２６", MEIO_DIA).data, "10/11/2026");
});
test("datas impossíveis ou texto", () => {
  for (const v of ["31/02/2027", "32/01/2027", "00/10/2026", "10/13/2026", "29/02/2027", "amanhã", "", null, undefined, "abc", "12345"]) {
    assert.equal(a(v, MEIO_DIA).motivo, "formato", String(v));
  }
});
test("29/02 em ano bissexto", () => {
  assert.equal(a("29/02/2028", MEIO_DIA).data, "29/02/2028");
});
test("virada de ano e de mês", () => {
  const ult = new Date("2026-12-31T20:00:00Z"); // 17h em Brasília
  assert.equal(a("01/01/2027", ult).ok, true);
  assert.equal(a("31/12/2026", ult).motivo, "proxima");
  const fimMes = new Date("2026-11-30T12:00:00Z");
  assert.equal(a("01/12/2026", fimMes).ok, true);
});
test("horários", () => {
  const ok = { "13:30": "13:30", "9:30": "09:30", "09:05": "09:05", "13h": "13:00", "13h30": "13:30", "13 h 30": "13:30", "8h": "08:00", "13.30": "13:30", " 07:00 ": "07:00", "00:00": "00:00", "23:59": "23:59" };
  for (const [k, v] of Object.entries(ok)) assert.equal(h(k), v, k);
  for (const k of ["24:00", "12:60", "abc", "", null, "1330", "25h", "13:5"]) assert.equal(h(k), null, String(k));
});
