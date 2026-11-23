import assert from "node:assert/strict";
import test from "node:test";
import { dashboardLanguage, translate } from "../dist/web/i18n.js";

test("uses the first supported browser language, defaulting to English", () => {
  assert.equal(dashboardLanguage(["zh-TW", "en-US"]), "zh-CN");
  assert.equal(dashboardLanguage(["ja-JP", "en-GB", "zh-CN"]), "en");
  assert.equal(dashboardLanguage(["ja-JP", "zh-Hant"]), "zh-CN");
  assert.equal(dashboardLanguage(["ja-JP"]), "en");
  assert.equal(dashboardLanguage([]), "en");
});

test("localizes legacy status payloads without changing custom labels", () => {
  const note = "sync_state：RPC 返回错误（-28）。 get_indexer_tip：上游返回 HTTP 503。";
  assert.equal(translate("zh-CN", note), note);
  assert.equal(translate("en", note), "sync_state: RPC returned error -28. get_indexer_tip: The upstream service returned HTTP 503.");
  assert.equal(translate("en", "RPC 在线；链上检查未成功。上游请求超时。"), "RPC is online, but the on-chain check failed. The upstream request timed out.");
  assert.equal(translate("en", "自定义服务"), "自定义服务");
});
