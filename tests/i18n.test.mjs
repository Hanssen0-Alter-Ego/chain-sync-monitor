import assert from "node:assert/strict";
import test from "node:test";
import { dashboardLanguage, en, translate } from "../dist/web/i18n.js";
import { ja, zhHant } from "../dist/web/locales.js";
import fr from "../dist/web/fr.js";
import de from "../dist/web/de.js";

test("uses the first supported browser language, defaulting to English", () => {
  assert.equal(dashboardLanguage(["zh-TW", "en-US"]), "zh-Hant");
  assert.equal(dashboardLanguage(["zh-HK"]), "zh-Hant");
  assert.equal(dashboardLanguage(["zh-MO"]), "zh-Hant");
  assert.equal(dashboardLanguage(["zh-Hant"]), "zh-Hant");
  assert.equal(dashboardLanguage(["zh-Hans-TW"]), "zh-CN");
  assert.equal(dashboardLanguage(["zh-CN"]), "zh-CN");
  assert.equal(dashboardLanguage(["ja-JP", "en-GB", "zh-CN"]), "ja");
  assert.equal(dashboardLanguage(["es-ES", "fr-CA", "de-DE"]), "fr");
  assert.equal(dashboardLanguage(["de-AT", "en"]), "de");
  assert.equal(dashboardLanguage(["es-ES"]), "en");
  assert.equal(dashboardLanguage([]), "en");
});

test("maintains key parity and nonempty translations in all shipped locale dictionaries", () => {
  const keys = Object.keys(en).sort();
  for (const dictionary of [zhHant, ja, fr, de]) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys);
    for (const key of keys) assert.ok(dictionary[key]?.trim(), key);
  }
});

test("localizes legacy status payloads without changing custom labels", () => {
  const note = "sync_state：RPC 返回错误（-28）。 get_indexer_tip：上游返回 HTTP 503。";
  assert.equal(translate("zh-CN", note), note);
  assert.equal(translate("en", note), "sync_state: RPC returned error -28. get_indexer_tip: The upstream service returned HTTP 503.");
  assert.equal(translate("en", "RPC 在线；链上检查未成功。上游请求超时。"), "RPC is online, but the on-chain check failed. The upstream request timed out.");
  for (const locale of ["zh-Hant","ja","fr","de"]) {
    const localized = translate(locale, note);
    assert.match(localized, /sync_state: .*?-28.*?get_indexer_tip: .*?503/u);
    assert.doesNotMatch(localized, /返回错误|上游返回/);
    assert.equal(translate(locale, "自定义服务"), "自定义服务");
  }
});

test("localizes the DOB Decoder metric and diagnostics without translating protocol identifiers", () => {
  const label = "DOB 协议版本";
  const note = "DOB Decoder 未返回有效的协议版本。";
  for (const locale of ["en", "zh-Hant", "ja", "fr", "de"]) {
    assert.notEqual(translate(locale, label), label);
    assert.notEqual(translate(locale, note), note);
    assert.equal(translate(locale, "dob/0, dob/1"), "dob/0, dob/1");
  }
});
