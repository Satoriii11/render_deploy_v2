import {delayCharts, disruptionCharts} from "./presentation.mjs";
const PLAN_LABELS = {cost:"成本优先",risk:"风险优先"};
const numberLabel = new Intl.NumberFormat("zh-CN", {maximumFractionDigits:2});
const moneyLabel = new Intl.NumberFormat("zh-CN", {minimumFractionDigits:2,maximumFractionDigits:2});
const validNumber = value => typeof value === "number" && Number.isFinite(value);
const fmt = value => validNumber(value) ? numberLabel.format(value) : "—";
const money = value => validNumber(value) ? moneyLabel.format(value) : "—";
const mdCell = value => String(value ?? "—").replaceAll("|","｜").replace(/[\r\n]+/g," ");
const cents = value => Math.round(value * 100);
const table = (headers, rows) => [
  "| " + headers.join(" | ") + " |",
  "| " + headers.map(()=>"---").join(" | ") + " |",
  ...rows.map(row=>"| " + row.map(mdCell).join(" | ") + " |"),
];
const graph = (title, unit, values, digits = 2) => ({
  title, unit, digits, points:values.filter(([,value])=>validNumber(value)).map(([label,value])=>({label,value})),
});

function calendarDay(value) {
  const day = String(value ?? "").slice(0,10);
  const date = new Date(day);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(+date) && date.toISOString().slice(0,10) === day ? day : "";
}

export function buildDelayContext(disruption, evaluationDate) {
  const data = disruption?.modified_risk_data;
  const request = data?.request;
  const deadline = calendarDay(request?.["要求到货日期"]);
  if (!deadline || !calendarDay(evaluationDate) || !Array.isArray(data.suppliers)) return null;
  const sku = request["需求SKU_ID"];
  const unitLimit = Number(request["统一采购单价上限_CNY每件"]);
  if (!Number.isFinite(unitLimit) || unitLimit <= 0) return null;
  const quotes = [];
  const pools = new Map();
  const seen = new Set();
  for (const supplier of data.suppliers) {
    for (const quote of supplier.quotes ?? []) {
      const pool = quote.pool_id ? String(quote.pool_id) : "";
      if (pool && validNumber(quote.pool_limit)) {
        pools.set(pool, Math.min(pools.get(pool) ?? Infinity, Math.max(0,Math.floor(quote.pool_limit))));
      }
      const id = String(quote.quote_id || "");
      const arrival = calendarDay(quote.delivery_date);
      if (!id || !supplier.supplier_id || quote.sku_id !== sku
          || !arrival || arrival < evaluationDate || !Array.isArray(quote.reasons)
          || quote.reasons.some(reason=>reason !== "预计到货晚于要求日期")
          || !validNumber(quote.total_risk_R) || quote.total_risk_R >= 60
          || !validNumber(quote.capacity) || quote.capacity < 1
          || !validNumber(quote.unit_price) || quote.unit_price <= 0 || quote.unit_price > unitLimit
          || !validNumber(quote.unit_landed_cost) || quote.unit_landed_cost <= 0
          || !validNumber(quote.fixed_shipping) || quote.fixed_shipping < 0) continue;
      const key = JSON.stringify([supplier.supplier_id,id]);
      if (seen.has(key)) return null;
      seen.add(key);
      quotes.push({id, supplierId:supplier.supplier_id, supplier:supplier.supplier_name,
        arrival, capacity:Math.floor(quote.capacity), pool, unit:cents(quote.unit_landed_cost),
        fixed:cents(quote.fixed_shipping)});
    }
  }
  return {sku, deadline, evaluationDate, quotes, pools:[...pools]};
}

function remainingSupply(context, plan, gap) {
  const byQuote = new Map();
  const bySupplier = new Map();
  const usedPools = new Map();
  const pools = new Map(context.pools);
  for (const row of plan.allocation) {
    byQuote.set(JSON.stringify([row.supplier_id,row.quote_id]), row.quantity);
    bySupplier.set(row.supplier_id, row.quote_id);
    if (row.pool_id) usedPools.set(row.pool_id, (usedPools.get(row.pool_id) || 0) + row.quantity);
  }
  for (const [key, quantity] of usedPools) pools.set(key,Math.max(0,(pools.get(key) ?? 0)-quantity));
  const candidates = [];
  for (const quote of context.quotes) {
    if (bySupplier.has(quote.supplierId) && bySupplier.get(quote.supplierId) !== quote.id) continue;
    const placed = byQuote.get(JSON.stringify([quote.supplierId,quote.id])) || 0;
    const quantity = Math.min(gap, quote.capacity-placed, quote.pool ? pools.get(quote.pool) ?? 0 : Infinity);
    if (quantity > 0) candidates.push({...quote, quantity, fixed:placed > 0 ? 0 : quote.fixed});
  }
  return {candidates, pools};
}

function bestSupplement(options, poolLimits, gap, budget) {
  const optionsBySupplier = new Map();
  for (const item of options) {
    if (!optionsBySupplier.has(item.supplierId)) optionsBySupplier.set(item.supplierId,[]);
    optionsBySupplier.get(item.supplierId).push(item);
  }
  const groups = [...optionsBySupplier.values()];
  const remaining = new Map(poolLimits);
  const allocation = [];
  let best = {quantity:0, cost:0, allocation:[]};
  let states = 0;
  function search(index, quantity, cost) {
    if (++states > 1_000_000) return false;
    if (quantity > best.quantity || (quantity === best.quantity && cost < best.cost)) {
      best = {quantity,cost,allocation:[...allocation]};
    }
    if (index === groups.length || quantity === gap) return true;
    for (const quote of groups[index]) {
      const availablePool = quote.pool ? remaining.get(quote.pool) : Infinity;
      const availableBudget = Math.floor((budget - cost - quote.fixed) / quote.unit);
      const count = Math.min(gap-quantity,quote.quantity,availablePool,availableBudget);
      for (let take = count; take > 0; take--) {
        const subtotal = quote.fixed + take * quote.unit;
        if (quote.pool) remaining.set(quote.pool,availablePool-take);
        allocation.push({supplier:quote.supplier,id:quote.id,quantity:take,arrival:quote.arrival,subtotal});
        const complete = search(index+1,quantity+take,cost+subtotal);
        allocation.pop();
        if (quote.pool) remaining.set(quote.pool,availablePool);
        if (!complete) return false;
      }
    }
    return search(index+1,quantity,cost);
  }
  if (groups.length > 60 || !search(0,0,0)) return null;
  return best;
}

export function delayAnalysis(scenario, planKey, extensionDays) {
  const plan = scenario["reoptimized_" + planKey + "_plan"];
  const gap = plan?.unmet_quantity;
  if (!Number.isSafeInteger(gap) || gap < 0 || !Array.isArray(plan.allocation)) {
    return {answer:"该断供结果缺少可用的重优化方案，请重新运行断供模拟。"};
  }
  if (gap === 0) return {answer:"所选的" + PLAN_LABELS[planKey] + "重优化方案已经覆盖全部需求，无需通过延期补货。",
    advice:["按原交期确认重优化方案中的供应商承诺和预计到货日。"]};
  const context = scenario.delay;
  if (!context || !validNumber(scenario.budget) || !validNumber(plan.total_cost)) {
    return {answer:"该断供结果缺少原要求到货日、有效报价快照或预算，暂时无法计算延期补货。请核对数据后重新运行断供模拟。"};
  }
  const budget = Math.max(0,cents(scenario.budget)-cents(plan.total_cost));
  const {candidates,pools} = remainingSupply(context,plan,gap);
  const firstDay = new Date(context.deadline + "T00:00:00Z");
  // Add every meaningful supplier arrival cutoff in addition to the presets.
  // This is display granularity only: each window still runs the original solver.
  const maxDay = Math.max(10,extensionDays ?? 0);
  const arrivalDays = candidates.map(q=>Math.round((Date.parse(q.arrival+"T00:00:00Z")-firstDay)/86_400_000))
    .filter(day=>Number.isInteger(day)&&day>=0&&day<=maxDay);
  const days = [...new Set([0,3,5,7,10,extensionDays ?? 0,...arrivalDays])].sort((a,b)=>a-b);
  const windows = [];
  const byCutoff = new Map();
  for (const delay of days) {
    const cutoff = new Date(+firstDay + delay * 86_400_000).toISOString().slice(0,10);
    const options = candidates.filter(item=>item.arrival <= cutoff);
    const cacheKey = options.length;
    if (!byCutoff.has(cacheKey)) byCutoff.set(cacheKey,bestSupplement(options,pools,gap,budget));
    const result = byCutoff.get(cacheKey);
    if (!result) return {answer:"该场景的组合数量超过计算上限，无法给出经过验证的最优补货量。请缩短延期窗口或缩小候选供应商范围。"};
    windows.push({...result, delay, cutoff, residual:gap-result.quantity});
  }
  // Recheck the actual arrival dates so the recommendation is not limited to the preset windows.
  const dates = [...new Set(candidates.map(q=>q.arrival))].sort();
  const lastCutoff = windows.at(-1).cutoff;
  let earliest = windows[0].residual === 0 ? windows[0] : null;
  for (const cutoff of dates) {
    if (earliest || cutoff <= context.deadline || cutoff > lastCutoff) continue;
    const options = candidates.filter(q=>q.arrival <= cutoff);
    if (!byCutoff.has(options.length)) byCutoff.set(options.length,bestSupplement(options,pools,gap,budget));
    const result = byCutoff.get(options.length);
    if (result?.quantity === gap) earliest = {...result,cutoff,delay:(new Date(cutoff)-firstDay)/86_400_000,residual:0};
    if (!result) break;
  }
  const best = earliest || windows.find(row=>row.residual === 0) ||
    windows.reduce((a,b)=>b.quantity > a.quantity ? b : a);
  const answer = [
    "## 断供缺口延期情景",
    (scenario.request_info?.company || "本次采购企业") + " · " + PLAN_LABELS[planKey] + " · " + (scenario.request_info?.product || "采购产品名称待核实"),
    "原要求到货日 " + context.deadline + " · 报价评估日 " + context.evaluationDate,
    "重优化后仍缺 **" + gap + " 件**，可用预算 **" + money(budget/100) + " 元**。",
    "",
    ...table(["延期","最晚到货","可补件数","仍缺","增量成本"], windows.map(row=>[
      row.delay + " 天",row.cutoff,row.quantity,row.residual,money(row.cost/100) + " 元",
    ])),
    "",
    best.residual === 0
      ? "**最早补齐窗口** · " + best.delay + " 天 · " + best.cutoff + " · 预计增量成本 " + money(best.cost/100) + " 元。"
      : "**最佳已评估窗口** · " + best.delay + " 天 · 可补 " + best.quantity + " 件 · 仍缺 " + best.residual + " 件。",
    "",
    ...(best.allocation.length ? table(["补货供应商","产品","数量","预计到货","增量金额"], best.allocation.map(row=>[
      row.supplier,scenario.request_info?.product || "采购产品",row.quantity,row.arrival,money(row.subtotal/100) + " 元",
    ])) : []),
    "",
    "保留重优化的已分配数量。增补使用本次断供后的剩余产能和预算，扣除已用共享库存。新报价计入固定运费，既有报价按追加原订单估算。结果基于评估日有效的原料报价，实际下单前需确认报价和交付承诺。",
  ].join("\n");
  return {answer, kpis:[{label:"原重优化缺口",value:gap+"件"},{label:"最早补齐所需延期",value:earliest?earliest.delay+"天":"尚未补齐"},{label:"所选最佳窗口剩余缺口",value:best.residual+"件"}], charts:delayCharts(windows,gap),
    advice:best.residual === 0
      ? ["与需求方确认可接受的最早到货日 " + best.cutoff + "，再向表中的供应商锁定补货量、报价有效期和交期。"]
      : ["先确认可补的 " + best.quantity + " 件。对剩余 " + best.residual + " 件进入缺口恢复，评估替代料或其他供应来源。"]};
}

export function decisionReport(scenario, resilience) {
  const rows = [["cost",scenario.reoptimized_cost_plan],["risk",scenario.reoptimized_risk_plan]];
  const comparisons = resilience?.comparisons || {};
  const percentage = value => validNumber(value) ? fmt(value) + "%" : "—";
  const baseline = rows.flatMap(([key])=>{
    const metrics = comparisons[key+"_priority"];
    // A successful Dify resilience result requires the original plan to meet all demand.
    return metrics ? [["断供前 · " + PLAN_LABELS[key], fmt(scenario.demand), "0", "100%",
      money(metrics.before_cost), fmt(metrics.before_risk), fmt(metrics.before_hhi)]] : [];
  });
  const overview = rows.map(([key,plan])=>{
    const metrics = comparisons[key+"_priority"];
    return ["重优化 · " + PLAN_LABELS[key], fmt(plan.fulfilled_quantity), fmt(plan.unmet_quantity),
      percentage(metrics?.fulfillment_rate_pct ?? 100*plan.fulfilled_quantity/scenario.demand),
      money(plan.total_cost), fmt(plan.average_risk), fmt(metrics?.after_hhi)];
  });
  const details = rows.flatMap(([key,plan])=>[
    "", "### " + PLAN_LABELS[key] + " · 供应商分配",
    ...(plan.allocation.length ? table(["供应商","产品","采购件数","小计（元）"],plan.allocation.map(row=>[
      row.supplier_name || "供应商名称待核实",scenario.request_info?.product || "采购产品",row.quantity,money(row.subtotal),
    ])) : ["该方案当前没有可分配的采购量。"]),
  ]);
  const charts = disruptionCharts(scenario,resilience);
  const cost = rows[0][1];
  const risk = rows[1][1];
  const best = cost.fulfilled_quantity >= risk.fulfilled_quantity ? cost : risk;
  const advice = best.unmet_quantity > 0
    ? ["先确认重优化可覆盖的 " + best.fulfilled_quantity + " 件，再对 " + best.unmet_quantity + " 件剩余缺口运行延期补货。",
       "已分配支出只对应当前能买到的数量。比较方案时把后续补货成本和缺货影响一起考虑。"]
    : ["当前方案已覆盖全部需求，先和供应商确认数量及原交期，再执行所选方案。"];
  if (cost.fulfilled_quantity === risk.fulfilled_quantity && validNumber(risk.average_risk)
      && validNumber(cost.average_risk) && risk.average_risk < cost.average_risk) {
    advice.push("两方案覆盖量相同。风险优先方案的平均风险低 " + fmt(cost.average_risk-risk.average_risk) +
      " 分，支出差为 " + money(risk.total_cost-cost.total_cost) + " 元，可按风险偏好选择。");
  }
  return {
    answer:[
      "## 断供重优化决策报告",
      (scenario.request_info?.company || "本次采购企业") + " · " + (scenario.request_info?.product || "采购产品") + " · 净需求 " + scenario.demand + " 件 · 预算 " + money(scenario.budget) + " 元",
      "断供供应商 " + (scenario.disrupted_supplier_name || "供应商名称待核实") + " · 断供比例 " + fmt(scenario.disruption_rate*100) + "%",
      "",
      ...table(["采购方案","覆盖件数","缺口件数","满足率","支出（元）","平均风险","HHI"],[...baseline,...overview]),
      ...details,
      "",
      "HHI 按已分配采购量计算，数值越高表示采购量越集中。平均风险和支出按已分配数量计算。",
    ].join("\n"),
    charts, kpis:[{label:"本次采购需求",value:scenario.demand+"件"},{label:"成本优先保障",value:cost.fulfilled_quantity+"件"},{label:"剩余缺口",value:cost.unmet_quantity+"件"}], advice, report:true,
  };
}

export function featureInsights(feature, output) {
  if (feature === "purchase_optimize" && output?.cost_plan && output?.risk_plan) {
    const cost = output.cost_plan, risk = output.risk_plan;
    return {
      charts:[
        graph("方案总成本","元",[["成本优先",cost.total_cost],["风险优先",risk.total_cost]]),
        graph("方案平均风险","分",[["成本优先",cost.average_risk],["风险优先",risk.average_risk]]),
      ],
      advice:[risk.average_risk < cost.average_risk
        ? "两方案均满足需求。风险优先方案的平均风险低 " + fmt(cost.average_risk-risk.average_risk) + " 分，支出差 " + money(risk.total_cost-cost.total_cost) + " 元。确认风险偏好后再选方案。"
        : "在报告所列风险水平相同的情况下，优先核对成本优先方案的报价与承诺量。"],
    };
  }
  if (feature === "supplier_risk" && Array.isArray(output?.suppliers)) {
    const candidates = output.suppliers.filter(s=>validNumber(s.best_eligible_risk)).slice(0,8);
    return {
      charts:[graph("合格报价最低风险分","分",candidates.map(s=>[s.supplier_name+"（"+s.supplier_id+"）",s.best_eligible_risk]))],
      advice:candidates.length ? ["先向 " + candidates[0].supplier_name + "（" + candidates[0].supplier_id + "）核实报价有效期、可供量和交期，再比较其他合格报价。"]
        : ["先核查报价被排除的原因，补齐供货承诺、资质或风险资料后再进入方案优化。"],
    };
  }
  if (feature === "shortage_recovery" && output) {
    if ((output.shortage ?? output.shortage_quantity) === 0) {
      return {advice:["当前没有待恢复缺口。继续跟进现有采购计划的到货承诺。"]};
    }
    return {advice:[output.conditional_candidates === 0
      ? "当前报价未通过初筛，先确认库存、预算及交期，必要时发起重新询价。"
      : "将可补量与确认量分开。先落实供应商承诺与交期，替代料通过工程审批后再纳入采购计划。"]};
  }
  return {};
}

