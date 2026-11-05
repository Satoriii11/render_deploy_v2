import { buildDelayContext, decisionReport, delayAnalysis, featureInsights } from "./decision.mjs";

const DIFY_CHAT_URL = "https://api.dify.ai/v1/chat-messages";
const PLAN_NODE = "1793264203974";
const DISRUPTION_NODE = "1793263571875";
const RESILIENCE_NODE = "1793338710841";
const INSIGHT_NODES = {
  supplier_risk: {"1793181839094":"risk_json"},
  purchase_optimize: {"1793183259654":"plan_json"},
  shortage_recovery: {"1793341411426":"recovery_json","1793344119009":"feasibility_json"},
};
const FEATURES = {
  supplier_risk: "供应商智能推荐与风险评估",
  purchase_optimize: "智能采购方案优化",
  disruption_sim: "供应链断供模拟与韧性分析",
  shortage_recovery: "采购缺口恢复与替代料评估",
  quote_delivery: "报价与交期情景分析",
};
const utf8 = new TextEncoder();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, {status, headers: {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}});
}

async function readBounded(stream, maxBytes) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestError(413, "请求参数过长。");
      }
      text += decoder.decode(value, {stream:true});
    }
  } finally {
    reader.releaseLock();
  }
}

function numeric(value, label, min, max, whole = false) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) || number < min || number > max || (whole && !Number.isSafeInteger(number))) {
    throw new RequestError(400, label + "格式无效。");
  }
  return number;
}

function parseInputs(body) {
  if (!body || typeof body !== "object" || !Object.hasOwn(FEATURES, body.feature)) throw new RequestError(400, "请选择一个采购功能。");
  const request_id = String(body.request_id ?? "").trim().toUpperCase();
  if (!/^REQ-\d{3}$/.test(request_id)) throw new RequestError(400, "采购请求编号格式应为 REQ-001。");
  const inputs = {feature:body.feature, request_id};
  const evaluationDate = String(body.evaluation_date ?? "").trim();
  if (evaluationDate) {
    const parsed = new Date(evaluationDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(evaluationDate) || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== evaluationDate) {
      throw new RequestError(400, "评估日期无效。");
    }
    inputs.evaluation_date = evaluationDate;
  }
  if (body.feature === "disruption_sim") {
    inputs.evaluation_date ??= new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0,10);
    inputs.disrupted_supplier_id = String(body.disrupted_supplier_id ?? "").trim();
    if (!inputs.disrupted_supplier_id || inputs.disrupted_supplier_id.length > 80) throw new RequestError(400, "请输入有效的断供供应商 ID。");
    inputs.disruption_rate = numeric(body.disruption_rate ?? 1, "断供比例", Number.MIN_VALUE, 1);
  }
  if (body.feature === "shortage_recovery") {
    inputs.shortage_source = body.shortage_source ?? "manual";
    if (inputs.shortage_source === "manual") {
      inputs.shortage_quantity = String(numeric(body.shortage_quantity, "缺口数量", 0, 1e9, true));
      inputs.remaining_budget = String(numeric(body.remaining_budget, "剩余预算", 0, 1e12));
    } else if (inputs.shortage_source === "simulation") {
      inputs.scenario_plan = body.scenario_plan ?? "cost";
      if (!["cost","risk"].includes(inputs.scenario_plan)) throw new RequestError(400, "请选择成本优先或风险优先方案。");
    } else {
      throw new RequestError(400, "请选择有效的缺口来源。");
    }
  }
  if (body.feature === "quote_delivery") {
    inputs.scenario_plan = body.scenario_plan ?? "cost";
    if (!["cost","risk"].includes(inputs.scenario_plan)) throw new RequestError(400, "请选择成本优先或风险优先方案。");
    if (body.extension_days !== "" && body.extension_days != null) {
      inputs.extension_days = numeric(body.extension_days, "延期天数", 0, 365, true);
    }
  }
  return inputs;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/, "");
}

function unbase64url(text) {
  return Uint8Array.from(atob(text.replaceAll("-","+").replaceAll("_","/")), c=>c.charCodeAt(0));
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", utf8.encode("procurement-scenarios.v1:" + secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
}

async function signScenario(scenario, user, secret) {
  const payload = base64url(utf8.encode(JSON.stringify({scenario,user,expires:Date.now()+3600_000})));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8.encode(payload));
  return payload + "." + base64url(new Uint8Array(signature));
}

async function readScenario(token, user, requestId, secret) {
  try {
    if (typeof token !== "string" || token.length > 88_000) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (extra || !payload || !signature) throw new Error();
    if (!await crypto.subtle.verify("HMAC", await hmacKey(secret), unbase64url(signature), utf8.encode(payload))) throw new Error();
    const {scenario, user: owner, expires} = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
    if (owner !== user || expires < Date.now() || scenario.request_id !== requestId) throw new Error();
    return scenario;
  } catch {
    throw new RequestError(400, "断供结果已失效或采购请求不匹配，请重新运行断供模拟。");
  }
}

function compactScenario(result, requestId, delay) {
  if (!result || result.request_id !== requestId) return null;
  const keys = ["request_id","demand","budget","disrupted_supplier_id","disrupted_supplier_name","disruption_rate","reoptimized_cost_plan","reoptimized_risk_plan"];
  const compact = Object.fromEntries(keys.map(key=>[key,result[key]]));
  if (JSON.stringify(compact).length > 48_000) return null;
  compact.delay = delay;
  // Leave room for token encoding and the request wrapper.
  if (utf8.encode(JSON.stringify(compact)).byteLength > 54_000) compact.delay = null;
  return utf8.encode(JSON.stringify(compact)).byteLength <= 54_000 ? compact : null;
}

function parseNodeObject(value) {
  try {
    const result = typeof value === "string" ? JSON.parse(value) : value;
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

async function runDify(inputs, user, apiKey, signal, fetcher) {
  const response = await fetcher(DIFY_CHAT_URL, {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":"Bearer "+apiKey},
    body:JSON.stringify({inputs,query:FEATURES[inputs.feature],user,response_mode:"streaming",auto_generate_name:false}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if ([401,403].includes(response.status)) throw new RequestError(502, "Dify 拒绝了服务凭据，请检查应用发布状态及服务端 API Key。");
    if (response.status === 429) throw new RequestError(429, "Dify 当前请求较多，请稍后重试。");
    throw new RequestError(502, "Dify 请求失败（HTTP " + response.status + "）。请在 Dify 检查应用和输入参数。");
  }
  let pending = "", answer = "", finished = false;
  let rawScenario, rawDisruption, rawResilience, rawInsight;
  const insight = INSIGHT_NODES[inputs.feature];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  function processLine(line) {
    if (!line.startsWith("data:")) return;
    let event;
    try {event = JSON.parse(line.slice(5).trim());} catch {return;}
    if (event.event === "error") throw new RequestError(502, "Dify 返回运行错误，请查看工作流执行记录。");
    if (event.event === "message" && typeof event.answer === "string") answer += event.answer;
    if (event.event === "node_finished") {
      const node = event.data;
      if (node?.outputs?.success === true && inputs.feature === "disruption_sim") {
        if (node.node_id === PLAN_NODE) rawScenario = node.outputs.reoptimized_json;
        if (node.node_id === DISRUPTION_NODE) rawDisruption = node.outputs.disruption_json;
        if (node.node_id === RESILIENCE_NODE) rawResilience = node.outputs.resilience_json;
      }
      const insightField = insight?.[node?.node_id];
      if (insightField && node.outputs?.success !== false) {
        rawInsight = node.outputs?.[insightField] ?? rawInsight;
      }
    }
    if (event.event === "workflow_finished") {
      if (event.data?.status !== "succeeded") throw new RequestError(502, "Dify 工作流未成功，请查看本次执行日志。");
      finished = true;
    }
  }
  try {
    while (!finished) {
      const {done,value} = await reader.read();
      if (done) {
        processLine(pending + decoder.decode());
        break;
      }
      pending += decoder.decode(value, {stream:true});
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (pending.length > 8_000_000 || answer.length > 500_000) throw new RequestError(502, "Dify 返回的结果超过网页显示上限。");
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  if (!finished || !answer.trim()) throw new RequestError(502, "Dify 未返回完整的分析结果，请重试。");
  const resilience = parseNodeObject(rawResilience);
  if (resilience && rawScenario) {
    const delay = buildDelayContext(parseNodeObject(rawDisruption),inputs.evaluation_date);
    const scenario = compactScenario(parseNodeObject(rawScenario),inputs.request_id,delay);
    if (scenario?.reoptimized_cost_plan && scenario.reoptimized_risk_plan) {
      return {...decisionReport(scenario,resilience),scenario};
    }
  }
  return {answer,...featureInsights(inputs.feature,parseNodeObject(rawInsight))};
}

function runDemo(inputs, scenario) {
  const id = inputs.request_id;
  const sku = "DEMO-ELE-01";
  const line = "采购请求 " + id + " · 示例物料 " + sku;
  if (inputs.feature === "supplier_risk") return {answer:[
    "## 供应商推荐与风险评估", line, "",
    "| 示例供应商 | 风险分 | 报价状态 |", "| --- | --- | --- |",
    "| 云杉电子 | 18.4 | 符合自动采购条件 |",
    "| 岩桥科技 | 27.2 | 符合自动采购条件 |",
    "| 浦青精工 | 42.1 | 预计到货需确认 |", "",
    "优先核实云杉电子的可供量，再评估岩桥科技作为第二来源。"
  ].join("\n")};
  if (inputs.feature === "purchase_optimize") return {answer:[
    "## 智能采购方案优化", line, "",
    "| 方案 | 云杉电子 | 岩桥科技 | 合计 | 预计成本 |", "| --- | --- | --- | --- | --- |",
    "| 成本优先 | 67 件 | 50 件 | 117 件 | 4,303 元 |",
    "| 风险优先 | 70 件 | 47 件 | 117 件 | 4,306 元 |",
    "两份演示方案均满足需求量、供货上限和 5,200 元预算。"
  ].join("\n")};
  if (inputs.feature === "disruption_sim") {
    const lost = Math.round(70 * inputs.disruption_rate);
    const gap = Math.max(lost - 3,0);
    const fulfilled = 117-gap;
    const cost = 4306-gap*37;
    const plan = {fulfilled_quantity:fulfilled,unmet_quantity:gap,total_cost:cost,average_risk:24,
      allocation:[{supplier_id:"SUP-004",supplier_name:"示例原料供应商",quote_id:"DEMO-004",quantity:fulfilled,subtotal:cost}]};
    const scenario = {
      request_id:id,demand:117,budget:5200,disrupted_supplier_id:inputs.disrupted_supplier_id,
      disruption_rate:inputs.disruption_rate,reoptimized_cost_plan:plan,reoptimized_risk_plan:plan,
      delay:{sku, evaluationDate:"2026-11-04", deadline:"2026-11-15", pools:[], quotes:[
        {id:"DEMO-002",supplierId:"SUP-002",supplier:"岩桥科技",arrival:"2026-11-17",capacity:30,pool:"",unit:4000,fixed:8000},
        {id:"DEMO-003",supplierId:"SUP-003",supplier:"浦青精工",arrival:"2026-11-20",capacity:45,pool:"",unit:3900,fixed:10000},
      ]},
    };
    return {...decisionReport(scenario),scenario};
  }
  if (inputs.feature === "shortage_recovery") {
    const plan = scenario?.["reoptimized_"+inputs.scenario_plan+"_plan"];
    const shortage = plan?.unmet_quantity ?? Number(inputs.shortage_quantity);
    const budget = plan ? scenario.budget-plan.total_cost : Number(inputs.remaining_budget);
    const quantity = Math.min(shortage,24,Math.floor(budget/41));
    return {answer:["## 采购缺口恢复与替代料评估",line,
      "待恢复 "+shortage+" 件 · 剩余预算 "+budget.toFixed(2)+" 元", "",
      shortage ? "**候选替代料 DEMO-ALT-01** 预计可补 "+quantity+" 件，估算成本 "+(quantity*41)+" 元，待工程审批及供应商确认。" : "当前不存在采购缺口。",
      "已确认恢复量 0 件。"].join("\n")};
  }
}

export async function handleApi(request, env, user, fetcher = fetch) {
  const {pathname,origin} = new URL(request.url);
  const apiKey = env.DIFY_API_KEY?.trim();
  if (pathname === "/api/status" && request.method === "GET") return json({mode:apiKey ? "live" : "demo"});
  if (pathname !== "/api/analyze" || request.method !== "POST") return json({error:"请求地址无效。"},404);
  if (!user) return json({error:"请登录后使用采购工作台。"},401);
  if (request.headers.get("Origin") !== origin || !request.headers.get("Content-Type")?.startsWith("application/json")) {
    return json({error:"请从采购工作台页面提交分析。"},403);
  }
  try {
    let body;
    try {body = JSON.parse(await readBounded(request.body, 96_000));}
    catch (error) {if (error instanceof RequestError) throw error; throw new RequestError(400,"请求内容格式无效。");}
    const inputs = parseInputs(body);
    const secret = apiKey || "demo-scenario-only";
    let scenario = null;
    if (inputs.feature === "quote_delivery" || inputs.shortage_source === "simulation") {
      if (!body.scenario_token) throw new RequestError(400, "请先运行断供模拟，再引用重优化结果。");
      scenario = await readScenario(body.scenario_token,user,inputs.request_id,secret);
      if (inputs.shortage_source === "simulation") {
        const {delay, ...difyScenario} = scenario;
        inputs.scenario_json = JSON.stringify(difyScenario);
      }
    }
    const result = inputs.feature === "quote_delivery" ? delayAnalysis(scenario,inputs.scenario_plan,inputs.extension_days)
      : apiKey ? await runDify(inputs,user,apiKey,request.signal,fetcher) : runDemo(inputs,scenario);
    const {scenario:computed, ...content} = result;
    const response = {...content,demo:!apiKey};
    if (computed) {
      response.scenario_token = await signScenario(computed,user,secret);
      response.scenario_gaps = {
        cost:computed.reoptimized_cost_plan.unmet_quantity,
        risk:computed.reoptimized_risk_plan.unmet_quantity,
      };
    }
    return json(response);
  } catch (error) {
    if (error instanceof RequestError) return json({error:error.message},error.status);
    if (error?.name === "TimeoutError") return json({error:"Dify 响应超时，请稍后重试。"},504);
    return json({error:"分析服务暂时不可用，请稍后重试。"},502);
  }
}

