// Presentation-only transform for Dify's structured outputs.
// Mathematical optimization and risk-score formulas remain entirely in Dify.
const currency = new Intl.NumberFormat("zh-CN", {minimumFractionDigits:2, maximumFractionDigits:2});
const quantity = new Intl.NumberFormat("zh-CN", {maximumFractionDigits:2});
const n = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const num = value => n(value) == null ? "—" : quantity.format(value);
const money = value => n(value) == null ? "—" : currency.format(value);
const safe = value => String(value ?? "—").replaceAll("|","｜").replace(/[\r\n]+/g," ").replace(/\s+/g," ").trim() || "—";
const mdTable = (heads, rows) => ["| "+heads.map(safe).join(" | ")+" |", "| "+heads.map(()=>"---").join(" | ")+" |",...rows.map(row=>"| "+row.map(safe).join(" | ")+" |")].join("\n");
const names = {cost:"成本优先",risk:"风险优先"};
const mdNum = (value, unit="") => n(value) == null ? "—" : num(value) + unit;
const bar = (title, unit, values) => ({type:"bar",title,unit,points:values.filter(([,v])=>n(v)!=null).map(([label,value])=>({label:safe(label),value}))});
const donut = (title, unit, values) => ({type:"donut",title,unit,points:values.filter(([,v])=>n(v)!=null&&v>=0).map(([label,value])=>({label:safe(label),value}))});
const line = (title, unit, values) => ({type:"line",title,unit,points:values.filter(([,v])=>n(v)!=null).map(([x,value])=>({label:String(x)+"天",x,value}))});


// Group overlapping quote restrictions by business cause, preserving exactly which
// suppliers and offers contributed to each group. One quote may appear in >1 group.
const REASON_CATEGORIES = ["交期不满足","库存或可供能力不足","技术匹配与工程审批","断供或供应不可用","资质与合规","报价与预算","其他限制"];
export function classifyRestriction(reason) {
  const str = String(reason ?? "").replace(/\s+/g, "").toLowerCase();
  if (/晚于|交期|延迟|迟到|到货日期|超期交付/.test(str)) return "交期不满足";
  if (/库存|共享池|共享库存|剩余容量|供货量|可供量|可承诺|供给不足|产能|容量不足/.test(str)) return "库存或可供能力不足";
  if (/工程|sku|型号|封装|技术|参数|规格|匹配|替代|核验|验证|审批/.test(str)) return "技术匹配与工程审批";
  if (/断供|停供|供应商不可用|无法供货|停止供货/.test(str)) return "断供或供应不可用";
  if (/资质|合规|认证|许可|不合格|黑名单/.test(str)) return "资质与合规";
  if (/报价|有效期|预算|超价|单价|价格|运费/.test(str)) return "报价与预算";
  return "其他限制";
}
export function groupRestrictions(items) {
  const groups = new Map();
  for (const item of items) {
    const company = safe(item.company || item.name || item.supplier_name || "企业名称待核实");
    const raw = Array.isArray(item.reasons) && item.reasons.length ? item.reasons : ["未通过初筛，详细原因未提供"];
    // Dify may return multiple explanations as a single semicolon-separated string.
    const reasons=raw.flatMap(r=>String(r??"").split(/[；;，,]+/)).map(r=>r.trim()).filter(Boolean);
    const perQuote = new Map();
    for (const reason of reasons) {
      const category = classifyRestriction(reason);
      if (!perQuote.has(category)) perQuote.set(category,new Set());
      perQuote.get(category).add(safe(reason));
    }
    for (const [category, reasonsForGroup] of perQuote) {
      if (!groups.has(category)) groups.set(category,{category,count:0,companies:new Set(),reasons:new Set()});
      const group=groups.get(category);
      group.count++;
      group.companies.add(company);
      reasonsForGroup.forEach(text=>group.reasons.add(text));
    }
  }
  return [...groups.values()].sort((a,b)=>REASON_CATEGORIES.indexOf(a.category)-REASON_CATEGORIES.indexOf(b.category)).map(item=>({
    category:item.category,count:item.count,companies:[...item.companies],reasons:[...item.reasons],
  }));
}
function restrictionTable(groups) {
  return mdTable(["受限类别","对应企业","受影响报价","具体限制"],groups.map(g=>[
    g.category,g.companies.join("、"),g.count+"条",g.reasons.join("；")
  ]));
}

export function requestInfo(catalog, requestId) {
  return catalog?.requests?.find(row=>row.id===requestId) || null;
}
export function entityName(catalog, id, category="") {
  const key = String(id ?? "");
  if (!key) return "—";
  if (category === "supplier" || /^(?:COM|SUP)-\d+$/i.test(key)) return catalog?.supplierNames?.get(key) || "供应商名称待核实";
  if (category === "product" || /^(?:ELE|SIM-ALT)-/i.test(key)) return catalog?.productNames?.get(key) || "产品名称待核实";
  if (category === "request" || /^REQ-\d{3}$/i.test(key)) {
    const req = requestInfo(catalog,key);
    return req ? `${req.company}的${req.product}采购需求` : "当前采购需求";
  }
  return safe(key);
}

// Plain-text fallback when Dify has not supplied the structured output required
// for a particular feature. Does not invent suppliers, quotes or approvals.
export function humanizeText(text, catalog, reqId="") {
  let output = String(text ?? "").replace(/\r\n/g,"\n");
  const map = id => entityName(catalog,id);
  output = output.replace(/\bREQ-\d{3}\b/gi, id=>map(id));
  output = output.replace(/\b(?:COM|SUP)-\d+\b/gi,id=>map(id));
  output = output.replace(/\b(?:ELE-\d{4}|SIM-ALT-\d{4}-[A-Z])\b/gi,id=>map(id));
  output = output.replace(/\bDEMO-(?:ELE|ALT)-[\w-]+\b/gi,"演示产品");
  output = output.replace(/\b(?:QUO-\d+|QO-\d+|ORD-\w+|R-\d{8}-\d+)\b/gi,"对应记录");
  if (reqId && !output.trim()) {
    const req = requestInfo(catalog,reqId);
    output = req ? `本次分析对象：${req.company}采购${req.product}，需求${num(req.quantity)}件。` : "当前没有可展示的分析结果。";
  }
  return output;
}

function requestHeader(title, req) {
  return [`## ${title}`, req ? `**${safe(req.company)}**采购**${safe(req.product)}**，净需求 **${num(req.quantity)} 件**。` : "本次采购需求的结构化信息暂不可用。", ""];
}
function quoteName(catalog, id, fallback) {
  return fallback || entityName(catalog,id,"supplier");
}
function skuName(catalog, id, req) {
  return catalog?.productNames?.get(String(id)) || (req?.product ? req.product+"（候选型号待核验）" : "产品名称待核实");
}
function techStatus(code) {
  return ({ORIGINAL:"原件",PENDING_ENGINEERING:"待工程审批",REJECT_DIRECT:"禁止直接替代",NOT_ELIGIBLE:"本次不可用"})[code] || "状态待核验";
}
function quoteStatus(quote) {
  if (quote?.auto_eligible === true) return "通过自动采购初筛";
  return (quote?.reasons || []).join("；") || "未通过自动采购初筛";
}

export function riskPresentation(data, catalog, req) {
  if (!Array.isArray(data?.suppliers)) return null;
  const lines=requestHeader("供应商风险全量评估",req);
  lines.push(`本次共纳入 **${data.suppliers.length} 家候选供应商**。交付风险 D、质量风险 Q、集中度风险 S 为供应商指标；成本风险 C 和综合风险 R 按**具体报价**计算。同一家企业不同报价的 C、R 可能不同，因此下面保留每条报价的完整数据。图表仅比较具备自动采购资格的报价，未通过初筛的报价仍保留在表中。`,"");
  const full=[];
  let evaluatedQuoteCount=0;
  const chartRows=[];
  const risky=[];
  for (const s of data.suppliers) {
    const name=quoteName(catalog,s.supplier_id,s.supplier_name);
    const quotes=Array.isArray(s.quotes)?s.quotes:[];
    const chartScore = n(s.best_eligible_risk);
    if (chartScore!=null) chartRows.push([name,chartScore]);
    if (!quotes.length) full.push([name,"—","—","—",mdNum(s.delivery_risk_D),mdNum(s.quality_risk_Q),mdNum(s.concentration_risk_S),"—","—","—","暂无报价"]);
    for (const q of quotes) {
      evaluatedQuoteCount++;
      full.push([name,skuName(catalog,q.sku_id,req),mdNum(q.capacity,"件"),safe(q.delivery_date || "待确认"),mdNum(s.delivery_risk_D),mdNum(s.quality_risk_Q),mdNum(s.concentration_risk_S),mdNum(q.cost_risk_C),mdNum(q.total_risk_R),q.risk_level || "待评估",quoteStatus(q)]);
      if (!q.auto_eligible) risky.push({company:name,reasons:q.reasons});
    }
  }
  lines.push("### 全部供应商及报价风险明细",mdTable(["供应商","产品","可承诺量","预计到货","交付D","质量Q","集中S","成本C","综合R","风险级别","自动采购状态 / 原因"],full),"");
  const ranked = data.suppliers.filter(s=>n(s.best_eligible_risk)!=null).sort((a,b)=>a.best_eligible_risk-b.best_eligible_risk);
  const riskGroups=groupRestrictions(risky);
  if (riskGroups.length) {
    lines.push("### 受限原因与对应企业",restrictionTable(riskGroups),
      "同一条报价可能同时受交期、库存或审批等多项限制，各类别的报价数量不能相加为总报价数。","");
  }
  lines.push("### 业务判断");
  if (ranked.length) {
    lines.push(`按当前可自动采购报价的最低综合风险分，**${safe(quoteName(catalog,ranked[0].supplier_id,ranked[0].supplier_name))}**的分数相对较低（${num(ranked[0].best_eligible_risk)}）。但风险评分不能代替交期、库存池和报价有效性确认。`);
  } else lines.push("当前没有通过自动采购初筛的报价，应先核对未通过原因，再决定是否重新询价。 ");
  lines.push("需要特别关注未通过初筛的报价，不能仅因企业评分较低就直接下单。", "");
  return {answer:lines.join("\n"),kpis:[{label:"候选供应商",value:data.suppliers.length+"家"},{label:"通过自动采购初筛的供应商",value:ranked.length+"家"},{label:"全部已评估报价",value:evaluatedQuoteCount+"条"}],charts:[bar("有自动采购资格供应商的最低综合风险评分","分",chartRows),...(riskGroups.length?[{type:"reasonGroups",title:"未通过初筛的原因及涉及企业",groups:riskGroups}]:[])],advice:["按明细表核对全部报价的可用状态。正式下单前同时确认供货数量、库存池、报价有效期与到货日期。"]};
}

export function optimizePresentation(data, catalog, req) {
  if (!data?.cost_plan || !data?.risk_plan) return null;
  const rows=[["cost",data.cost_plan],["risk",data.risk_plan]];
  const lines=requestHeader("正常采购方案对比",req);
  lines.push(mdTable(["方案","满足数量","总成本（元）","平均风险","预算余额（元）"],rows.map(([type,p])=>[
    names[type],mdNum(p.total_quantity,"件"),money(p.total_cost),num(p.average_risk),money(p.budget_remaining)
  ])),"");
  for (const [key,p] of rows) {
    lines.push("### "+names[key]+" · 采购分配",mdTable(["供应商","采购件数","单位到货价（元）","固定运费（元）","金额（元）","报价风险"],(p.allocation||[]).map(a=>[
      quoteName(catalog,a.supplier_id,a.supplier_name),mdNum(a.quantity),money(a.unit_landed_cost),money(a.fixed_shipping),money(a.subtotal),num(a.risk)
    ])),"");
  }
  const cost=data.cost_plan,risk=data.risk_plan;
  lines.push("### 如何选择", `两套方案的费用差额为 **${money(Math.abs((n(cost.total_cost)||0)-(n(risk.total_cost)||0)))} 元**。风险优先方案能否带来更低的风险评分，以及是否值得增加费用，应结合库存、交期和断供敏感性共同判断。`,"");
  const allocationPanels=rows.map(([key,p])=>({
    label:names[key],
    points:(p.allocation||[]).map(a=>({label:quoteName(catalog,a.supplier_id,a.supplier_name),value:a.quantity})).filter(row=>n(row.value)!=null),
  }));
  return {answer:lines.join("\n"),kpis:[{label:"成本优先总成本",value:money(cost.total_cost)+"元"},{label:"风险优先总成本",value:money(risk.total_cost)+"元"},{label:"净采购需求",value:(req?.quantity ?? data.demand)+"件"}],charts:[bar("采购成本对比","元",[["成本优先",cost.total_cost],["风险优先",risk.total_cost]]),bar("方案平均风险","分",[["成本优先",cost.average_risk],["风险优先",risk.average_risk]]),{type:"splitBar",title:"各方案供应商分配",unit:"件",plans:allocationPanels}],advice:["在两套方案均可执行的前提下，根据成本预算与供应稳定性选择，并在下单前确认报价、交期和共享库存。"]};
}

export function recoveryPresentation({recovery,candidate,feasibility}, catalog, req) {
  if (!recovery && !candidate && !feasibility) return null;
  const base=feasibility||recovery||{};
  const shortage=base.shortage ?? recovery?.shortage_quantity ?? null;
  const confirmed = feasibility?.confirmed_extra_quantity ?? candidate?.confirmed_extra_quantity ?? recovery?.confirmed_extra_quantity ?? null;
  const lines=requestHeader("缺口恢复与替代料核验",req);
  lines.push(`待恢复数量：**${mdNum(shortage,"件")}**；可用预算：**${money(base.remaining_budget ?? recovery?.remaining_budget)}元**。以下报价均为条件性候选，不能将可能补货量直接视为已确认恢复量。`,"");
  if (Array.isArray(candidate?.candidates)) {
    const rows=candidate.candidates.filter(c=>c.category!=="ORIGINAL").map(c=>[
      skuName(catalog,c.sku_id,req),techStatus(c.category),safe(c.technical_difference || "未提供技术差异说明"),safe(c.engineering_checks || "需进一步核验"),safe(c.recommended_action)
    ]);
    lines.push("### 替代产品候选明细",mdTable(["产品 / 型号","技术状态","技术差异","核验重点","下一步"],rows),"");
  }
  const quoteRows=feasibility?.evaluated_quotes || [];
  const eligible=quoteRows.filter(q=>q.status==="PENDING_APPROVAL_AND_CONFIRMATION");
  if (feasibility) {
    lines.push(`共核验 **${quoteRows.length} 条报价**，其中 **${eligible.length} 条**满足当前条件性候选要求。下面逐条列出，而不是只汇报数量。`,"");
    if (eligible.length) lines.push("### 条件性可行报价明细",mdTable(["供应商","候选产品","初步可谈数量","预计到货","估算增量费用（元）","当前状态"],eligible.map(q=>[
      quoteName(catalog,q.supplier_id,q.supplier_name),skuName(catalog,q.sku_id,req),mdNum(q.possible_quantity_before_approval,"件"),safe(q.expected_arrival_date || "待确认"),money(q.estimated_incremental_cost),"待工程批准及供应商确认"
    ])),"");
    const rejected=quoteRows.filter(q=>q.status!=="PENDING_APPROVAL_AND_CONFIRMATION");
    if (rejected.length) lines.push("### 暂不可执行的报价与原因",mdTable(["供应商","候选产品","初步可谈数量","主要限制"],rejected.map(q=>[
      quoteName(catalog,q.supplier_id,q.supplier_name),skuName(catalog,q.sku_id,req),mdNum(q.possible_quantity_before_approval,"件"),safe((q.reasons||[]).join("；") || "当前暂不可执行")
    ])),"");
  }
  if (Array.isArray(recovery?.recovery_actions)) lines.push("### 执行顺序",mdTable(["建议行动","当前状态"],recovery.recovery_actions.map(a=>[a.action,a.status])),"");
  lines.push(`**当前已确认新增供货量：${mdNum(confirmed,"件")}。** 候选可谈数量按单条报价测算，部分报价可能共享同一库存池，不能简单相加。未经工程审批、正式供货承诺和交期核验，不应计入真正恢复的供货量。`,"");
  const tech=candidate?.candidates || [];
  const reasonGroups=groupRestrictions(quoteRows.filter(q=>q.status!=="PENDING_APPROVAL_AND_CONFIRMATION").map(q=>({
    company:quoteName(catalog,q.supplier_id,q.supplier_name),reasons:q.reasons,
  })));
  if (reasonGroups.length) {
    lines.push("### 受限类别与对应供应商",restrictionTable(reasonGroups),
      "一条报价可能涉及多种限制；每类下的企业是实际关联企业，不能跨类别合并计数。","");
  }
  const charts=[];
  if (tech.some(c=>c.category!=="ORIGINAL")) charts.push(bar("替代产品技术状态（不含原件）","种",[
    ["待工程审批",tech.filter(c=>c.category==="PENDING_ENGINEERING").length],
    ["不可直接使用",tech.filter(c=>["REJECT_DIRECT","NOT_ELIGIBLE"].includes(c.category)).length],
    ["可直接使用",tech.filter(c=>c.category==="DIRECT_APPROVED").length],
  ].filter(([,value])=>value>0)));
  if (reasonGroups.length) charts.push({type:"reasonGroups",title:"报价受限类别与涉及企业",groups:reasonGroups});
  if (eligible.length) charts.push(bar("条件性候选报价可谈数量","件",eligible.map(q=>[quoteName(catalog,q.supplier_id,q.supplier_name)+" · "+skuName(catalog,q.sku_id,req),q.possible_quantity_before_approval])));
  return {answer:lines.join("\n"),kpis:[{label:"待恢复缺口",value:mdNum(shortage,"件")},{label:"条件性候选报价",value:eligible.length+"条"},{label:"已确认新增供货",value:mdNum(confirmed,"件")}],charts,advice:["先确认技术审批责任人和验证计划，再逐项落实供应商库存、正式报价与交期；不要把待批候选当作已解决缺口。"]};
}

export function delayCharts(windows, demandGap) {
  return [line("延期天数与剩余缺口","件",windows.map(w=>[w.delay,w.residual])),bar("不同延期窗口可补数量","件",windows.map(w=>[w.delay+"天",w.quantity])),donut("最大延期窗口缺口分布","件",[["预计可补",Math.max(0,demandGap-(windows.at(-1)?.residual||0))],["仍待解决",windows.at(-1)?.residual||0]])];
}
export function disruptionCharts(scenario, resilience) {
  const demand = n(scenario?.demand) ?? 0;
  const plans = [["cost",scenario.reoptimized_cost_plan],["risk",scenario.reoptimized_risk_plan]];
  const cmp = resilience?.comparisons || {};
  const panels = plans.map(([key,plan])=>({
    label:names[key],total:demand,fulfilled:Math.max(0,n(plan?.fulfilled_quantity)??0),
    shortage:Math.max(0,n(plan?.unmet_quantity)??Math.max(0,demand-(n(plan?.fulfilled_quantity)??0))),
  }));
  const efficiency = plans.map(([key,plan])=>{
    const beforeMetrics=cmp[key+"_priority"];
    const beforeCost=n(beforeMetrics?.before_cost);
    const afterCost=n(plan?.total_cost);
    const fulfilled=n(plan?.fulfilled_quantity);
    return {
      label:names[key],demand,
      before:{fulfilled:beforeMetrics?demand:null,shortage:beforeMetrics?0:null,rate:beforeMetrics&&demand>0?100:null,unitCost:beforeCost!=null&&demand>0?beforeCost/demand:null},
      after:{fulfilled,shortage:n(plan?.unmet_quantity),rate:fulfilled!=null&&demand>0?fulfilled/demand*100:null,unitCost:afterCost!=null&&fulfilled>0?afterCost/fulfilled:null},
    };
  });
  return [
    {type:"fulfillment",title:"断供后可保障采购量（占总需求）",plans:panels},
    {type:"efficiency",title:"断供前后保障效率对比",plans:efficiency},
  ];
}
