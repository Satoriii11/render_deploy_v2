import {parseXlsxSheet} from "./xlsx.mjs";

const DEFAULT_REQUESTS_URL = "https://github.com/Satoriii11/Competition-of-agent/raw/refs/heads/main/06_%E7%94%A8%E6%88%B7%E7%BC%BA%E8%B4%A7%E9%87%87%E8%B4%AD%E8%AF%B7%E6%B1%82_%E5%AE%8C%E6%95%B4%E8%A1%A5%E9%BD%90%E5%B9%B6%E9%87%8D%E7%AE%97%E9%A2%84%E7%AE%97.xlsx";
const DEFAULT_QUOTES_URL = "https://github.com/Satoriii11/Competition-of-agent/raw/refs/heads/main/03_%E4%BE%9B%E5%BA%94%E5%95%86%E6%8A%A5%E4%BB%B7_%E9%87%8D%E7%AE%97%E4%BB%B7%E6%A0%BC.xlsx";
const DEFAULT_SKUS_URL = "https://github.com/Satoriii11/Competition-of-agent/raw/refs/heads/main/04_SKU%E5%8E%9F%E4%BB%B6%E5%8F%98%E4%BD%93%E4%BB%B7%E6%A0%BC_%E5%AF%B9%E9%BD%9002%E6%9B%B4%E6%96%B0.xlsx";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_WORKBOOK_BYTES = 12 * 1024 * 1024;

let cache = null;
let inflight = null;
let cacheKey = "";

export class OptionsDataError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "OptionsDataError";
    this.status = status;
  }
}

function normalizeId(value) {
  return String(value ?? "").trim().toUpperCase();
}

function text(value) {
  return String(value ?? "").trim();
}

async function fetchWorkbook(url, sheetName, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "follow",
      headers: {Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream"},
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OptionsDataError("采购数据源暂时无法连接，请稍后刷新页面。", 503);
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel?.();
    throw new OptionsDataError("采购数据源读取失败（HTTP " + (response?.status ?? "unknown") + "）。", 503);
  }
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_WORKBOOK_BYTES) {
    await response.body.cancel();
    throw new OptionsDataError("采购数据文件超过允许读取大小。", 503);
  }
  let bytes;
  try {
    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_WORKBOOK_BYTES) throw new Error("too_large");
    bytes = Buffer.from(data);
  } catch (error) {
    if (error?.message === "too_large") throw new OptionsDataError("采购数据文件超过允许读取大小。", 503);
    throw new OptionsDataError("采购数据文件下载不完整，请稍后重试。", 503);
  }
  try {
    return parseXlsxSheet(bytes, sheetName);
  } catch (error) {
    throw new OptionsDataError("采购数据文件解析失败（" + sheetName + "）：" + error.message, 503);
  }
}

function buildOptionData(requestRows, quoteRows, skuRows=[]) {
  if (!requestRows.length) throw new OptionsDataError("采购请求数据表为空或无法读取。", 503);
  if (!quoteRows.length) throw new OptionsDataError("供应商报价数据表为空或无法读取。", 503);

  const requests = [];
  const requestMap = new Map();
  for (const row of requestRows) {
    const id = normalizeId(row["请求ID"]);
    const company = text(row["采购企业名称"]);
    const product = text(row["零部件名称"]);
    const rawQuantity = row["净采购需求_件"] ?? row["申报需求数量_件"];
    const quantity = Number(rawQuantity);
    if (!/^REQ-\d{3}$/.test(id) || !company || !product || !Number.isSafeInteger(quantity) || quantity < 0) continue;
    const option = {id, company, product, quantity};
    const previous = requestMap.get(id);
    if (previous && (previous.company !== company || previous.product !== product || previous.quantity !== quantity)) {
      throw new OptionsDataError("采购请求数据存在重复编号且信息不一致，请检查 Excel。", 503);
    }
    if (!previous) {
      requestMap.set(id, option);
      requests.push(option);
    }
  }
  if (!requests.length) throw new OptionsDataError("没有找到可供选择的有效采购需求。", 503);

  // This mirrors the Dify risk workflow's candidate construction:
  // supplier_ids is the set of non-empty supplier IDs in quotes filtered by request_id.
  // The disruption legality node accepts a supplier when it appears in risk_json.suppliers.
  const suppliersByRequest = new Map();
  const supplierNames = new Map();
  const productNames = new Map();
  for (const row of requestRows) {
    const skuId = text(row["需求SKU_ID"]);
    const product = text(row["零部件名称"]);
    if (skuId && product) productNames.set(skuId,product);
  }
  for (const row of skuRows) {
    const skuId = text(row["SKU_ID"]);
    const product = text(row["零部件名称"]);
    if (!skuId || !product) continue;
    const difference = text(row["与原件参数差异"]);
    const variant = skuId.startsWith("SIM-ALT-") && difference && !/^(无|不适用|N\/A)$/i.test(difference);
    productNames.set(skuId, variant ? product + "（" + difference.slice(0,48) + "）" : product);
  }
  for (const row of quoteRows) {
    const requestId = normalizeId(row["请求ID"]);
    const supplierId = text(row["供应企业ID"]);
    const supplierName = text(row["供应企业名称"]);
    if (!requestId || !supplierId || !supplierName) continue;
    if (!requestMap.has(requestId)) continue;
    supplierNames.set(supplierId,supplierName);
    const skuId = text(row["报价SKU_ID"]);
    const product = text(row["零部件名称"]);
    if (skuId && product && !productNames.has(skuId)) productNames.set(skuId,product + (skuId.startsWith("SIM-ALT-") ? "（候选替代产品）" : ""));
    if (!suppliersByRequest.has(requestId)) suppliersByRequest.set(requestId, new Map());
    const supplierMap = suppliersByRequest.get(requestId);
    const existing = supplierMap.get(supplierId);
    if (existing && existing.name !== supplierName) {
      throw new OptionsDataError("供应商报价表中存在同一企业编号对应多个名称的情况，请检查数据。", 503);
    }
    if (!existing) supplierMap.set(supplierId, {id: supplierId, name: supplierName});
  }

  const suppliers = new Map();
  for (const [requestId, supplierMap] of suppliersByRequest) {
    suppliers.set(requestId, [...supplierMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
  }

  requests.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {requests, suppliers, supplierNames, productNames, loadedAt: new Date().toISOString()};
}

async function loadAll(env = {}, fetcher = fetch) {
  const requestsUrl = String(env.PROCUREMENT_REQUESTS_XLSX_URL || DEFAULT_REQUESTS_URL).trim();
  const quotesUrl = String(env.PROCUREMENT_QUOTES_XLSX_URL || DEFAULT_QUOTES_URL).trim();
  let parsedRequests, parsedQuotes, parsedSkus;
  try {
    // Fetch all three sources concurrently; SKU lookup is optional so a
    // temporary SKU-sheet failure never blocks the input selector.
    [parsedRequests, parsedQuotes, parsedSkus] = await Promise.all([
      fetchWorkbook(requestsUrl, "缺货采购请求", fetcher),
      fetchWorkbook(quotesUrl, "供应商模拟报价", fetcher),
      fetchWorkbook(String(env.PROCUREMENT_SKUS_XLSX_URL || DEFAULT_SKUS_URL).trim(), "SKU规格与参考价", fetcher).catch(()=>[]),
    ]);
  } catch (error) {
    if (error instanceof OptionsDataError) throw error;
    throw new OptionsDataError("采购数据源读取失败，请稍后重试。", 503);
  }
  return buildOptionData(parsedRequests, parsedQuotes, parsedSkus);
}

export async function getProcurementOptionData(env = {}, fetcher = fetch) {
  const key = [env.PROCUREMENT_REQUESTS_XLSX_URL || DEFAULT_REQUESTS_URL, env.PROCUREMENT_QUOTES_XLSX_URL || DEFAULT_QUOTES_URL, env.PROCUREMENT_SKUS_XLSX_URL || DEFAULT_SKUS_URL].join("\n");
  if (cache && cacheKey === key && cache.expiresAt > Date.now()) return cache.data;
  if (inflight && cacheKey === key) return inflight;
  cacheKey = key;
  inflight = loadAll(env, fetcher).then(data => {
    cache = {data, expiresAt: Date.now() + CACHE_TTL_MS};
    return data;
  }).finally(() => {inflight = null;});
  return inflight;
}

export function clearProcurementOptionCache() {
  cache = null;
  inflight = null;
  cacheKey = "";
}

export function presentProcurementOptions(data, requestId = "") {
  const requests = data.requests.map(row => ({...row}));
  const normalized = normalizeId(requestId);
  return {
    requests,
    suppliers: normalized ? (data.suppliers.get(normalized) || []).map(row => ({...row})) : [],
    selectedRequest: normalized || null,
    updatedAt: data.loadedAt,
  };
}
