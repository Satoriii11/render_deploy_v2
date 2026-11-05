const features = [
  {id:"supplier_risk", icon:"risk", short:"供应商风险", title:"供应商智能推荐", tail:"与风险评估", note:"供应商排序、报价与风险", desc:"按采购单查看供应商排名、报价可用性，以及交付、质量和集中度风险。", tint:"#e5f2e9", accent:"#2d775f"},
  {id:"purchase_optimize", icon:"plan", short:"采购优化", title:"智能采购", tail:"方案优化", note:"成本优先与风险优先", desc:"在需求量、供应能力和预算约束下，比对成本优先与风险优先的采购分配。", tint:"#e9eef8", accent:"#5369a1"},
  {id:"disruption_sim", icon:"sim", short:"断供模拟", title:"供应链断供模拟", tail:"与重优化", note:"重优化报告与韧性指标", desc:"模拟供应商断供，生成重优化决策报告，对比两套采购方案和断供前后的韧性指标。", tint:"#fbefde", accent:"#9c602b"},
  {id:"shortage_recovery", icon:"gap", short:"缺口恢复", title:"采购缺口恢复", tail:"与替代料评估", note:"补货策略与替代料", desc:"填入缺口和剩余预算，或引用本次断供分析，查看恢复建议及替代料的待确认事项。", tint:"#f0ebf6", accent:"#79609b"},
  {id:"quote_delivery", icon:"quote", short:"报价交期", title:"断供缺口", tail:"延期补货", note:"比较延期后还能补多少", desc:"引用断供重优化方案，对比延长到货时间后可补的件数、剩余缺口和增量成本。", tint:"#e5f1f5", accent:"#33758b"},
];
const defaults = {request_id:"", evaluation_date:"", disrupted_supplier_id:"", disruption_rate:"1",
  shortage_source:"manual", shortage_quantity:"", remaining_budget:"", scenario_plan:"cost", extension_days:""};
const $ = id => document.getElementById(id);
const svg = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const esc = value => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
let active = features[0];
let values = {...defaults};
let demo = true;
let connecting = true;
let available = false;
let busy = false;
let controller;
let latestScenario = null;
let sequence = 0;

function inline(value) {
  return esc(value).replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/\x60([^\x60]+)\x60/g,"<code>$1</code>");
}

function markdown(text) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  let list = "";
  function closeList() {
    if (list) parts.push("</" + list + ">");
    list = "";
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith("|") && /^\s*\|\s*[:\- ]+/.test(lines[i+1] || "")) {
      closeList();
      const cells = row => row.trim().replace(/^\||\|$/g,"").split("|").map(x=>inline(x.trim()));
      parts.push('<div class="table-wrap"><table><thead><tr>' + cells(line).map(x=>"<th>"+x+"</th>").join("") + "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        parts.push("<tr>"+cells(lines[i]).map(x=>"<td>"+x+"</td>").join("")+"</tr>");
        i++;
      }
      i--;
      parts.push("</tbody></table></div>");
      continue;
    }
    const bullet = line.match(/^([-•*]|\d+\.)\s+(.+)/);
    if (bullet) {
      const tag = /^\d/.test(bullet[1]) ? "ol" : "ul";
      if (list !== tag) {closeList(); list = tag; parts.push("<" + tag + ">");}
      parts.push((raw.startsWith(" ") ? '<li class="list-indent">' : "<li>") + inline(bullet[2]) + "</li>");
      continue;
    }
    closeList();
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) parts.push("<h3>" + inline(heading[1]) + "</h3>");
    else if (line) parts.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  return parts.join("");
}

function chartMarkup(charts) {
  const cards = (charts ?? []).filter(chart=>chart.points.length).map(chart=>{
    const max = chart.unit === "%" ? 100 : chart.title.includes("HHI") ? 1 : Math.max(1,...chart.points.map(point=>point.value));
    const format = new Intl.NumberFormat("zh-CN",{maximumFractionDigits:chart.digits ?? 2});
    return '<figure class="metric-chart"><figcaption>' + esc(chart.title) + '</figcaption>' +
      chart.points.map(point=>{
        const value = format.format(point.value) + (chart.unit ? " " + chart.unit : "");
        return '<div class="chart-row"><span>' + esc(point.label) + '</span><meter min="0" max="' + max +
          '" value="' + Math.max(0,point.value) + '" aria-label="' + esc(point.label + " " + value) +
          '" title="' + esc(value) + '"></meter><strong>' + esc(value) + '</strong></div>';
      }).join("") + "</figure>";
  });
  return cards.length ? '<section class="metric-grid" aria-label="对比图表">' + cards.join("") + '</section>' : "";
}

function scenarioAction(label, scenario, feature) {
  const action = document.createElement("button");
  action.type = "button";
  action.innerHTML = svg("arrow") + esc(label);
  action.onclick = () => {
    latestScenario = scenario;
    values.request_id = scenario.request_id;
    values.shortage_source = "simulation";
    values.scenario_plan = scenario.gaps?.cost > 0 ? "cost" : "risk";
    selectFeature(feature);
    $("fields").querySelector("select, input:not([readonly])")?.focus();
  };
  return action;
}

function addMessage(role, text, {sample=false, error=false, scenario=null, preview=false, charts, advice, report=false, requestId}={}) {
  const row = document.createElement("article");
  row.className = "message " + role + (error ? " error" : "");
  row.id = "message-" + (++sequence);
  const label = error ? "运行提示" : preview ? "采策 · 操作提示" : "采策 · 分析结果";
  row.innerHTML = '<span class="avatar">' + svg(role === "user" ? "person" : "spark") + '</span><div class="bubble">'
    + (role === "assistant" ? '<div class="message-meta"><span>' + label + '</span>' + (sample ? '<span class="sample-mark">演示数据</span>' : "") + "</div>" : "")
    + (role === "assistant" ? markdown(text) : esc(text)) + "</div>";
  if (role === "assistant" && !preview && !error) {
    const bubble = row.querySelector(".bubble");
    const chartSection = chartMarkup(charts);
    const body = bubble.querySelector(".message-meta");
    if (chartSection) body.insertAdjacentHTML("afterend",chartSection);
    if (advice?.length) {
      bubble.insertAdjacentHTML("beforeend",'<section class="purchase-advice"><h4>采购建议</h4><ul>' +
        advice.map(item=>"<li>" + esc(item) + "</li>").join("") + "</ul></section>");
    }
    const reportText = advice?.length ? text + "\n\n## 采购建议\n" + advice.map(item=>"- " + item).join("\n") : text;
    const tools = document.createElement("div");
    tools.className = "message-tools";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.innerHTML = svg("copy") + "复制结果";
    copy.onclick = async () => {
      try {await navigator.clipboard.writeText(reportText); copy.textContent = "已复制";}
      catch {copy.textContent = "请选中文字后复制";}
    };
    tools.append(copy);
    if (report) {
      const download = document.createElement("a");
      download.textContent = "下载决策报告";
      download.download = requestId + "-断供重优化决策报告.md";
      download.href = "#";
      download.onclick = event => {
        event.preventDefault();
        const href = URL.createObjectURL(new Blob([reportText],{type:"text/markdown;charset=utf-8"}));
        const file = Object.assign(document.createElement("a"),{href,download:download.download});
        file.click();
        setTimeout(()=>URL.revokeObjectURL(href),1000);
      };
      tools.append(download);
    }
    if (scenario && Object.values(scenario.gaps ?? {}).some(gap=>gap > 0)) {
      tools.append(scenarioAction("测算延期能否补齐",scenario,"quote_delivery"),
        scenarioAction("评估缺口和替代料",scenario,"shortage_recovery"));
    }
    bubble.append(tools);
  }
  $("feed").append(row);
  return row;
}

function field(name, label, attrs="", options=null) {
  const value = esc(values[name] ?? "");
  const control = options ? '<select name="'+name+'">'+options.map(([v,l])=>'<option value="'+v+'" '+(v===values[name]?"selected":"")+'>'+l+'</option>').join("")+'</select>'
    : '<input name="'+name+'" value="'+value+'" '+attrs+'>';
  return '<label class="field"><span>'+label+'</span>'+control+'</label>';
}

function renderFields() {
  const fromDisruption = active.id === "quote_delivery";
  let fields = field("request_id","采购请求编号", fromDisruption
    ? 'readonly placeholder="先运行断供模拟"'
    : 'required placeholder="如 REQ-001" maxlength="7" autocomplete="off"');
  if (!fromDisruption) fields += field("evaluation_date","评估日期（选填）",'type="date"');
  if (active.id === "disruption_sim") {
    fields += field("disrupted_supplier_id","断供供应商 ID",'required maxlength="80" placeholder="如 SUP-001"');
    fields += field("disruption_rate","断供比例（0–1）",'type="number" required min="0.001" max="1" step="any"');
  }
  if (active.id === "shortage_recovery") {
    fields += field("shortage_source","缺口来源","",[["manual","手填缺口"],...(latestScenario ? [["simulation","引用本次断供结果"]] : [])]);
    if (values.shortage_source === "simulation") {
      fields += field("scenario_plan","重优化方案","",[["cost","成本优先"],["risk","风险优先"]]);
    } else {
      fields += field("shortage_quantity","缺口数量（件）",'required type="number" min="0" step="1"');
      fields += field("remaining_budget","剩余预算（元）",'required type="number" min="0" step="0.01"');
    }
  }
  if (active.id === "quote_delivery") {
    if (latestScenario) {
      const gaps = latestScenario.gaps;
      fields += field("scenario_plan","重优化方案","",[
        ["cost","成本优先" + (gaps ? " · 缺 " + gaps.cost + " 件" : "")],
        ["risk","风险优先" + (gaps ? " · 缺 " + gaps.risk + " 件" : "")],
      ]);
    }
    fields += field("extension_days","自定义延期（天）",'type="number" min="0" max="365" step="1" placeholder="选填，如 12"');
  }
  $("fields").innerHTML = fields;
  const hints = {
    supplier_risk:"输入采购请求编号，评估日期留空时使用北京时间当天。",
    purchase_optimize:"结果同时给出成本优先和风险优先的方案。",
    disruption_sim:"比例填 1 表示完全断供。供应商 ID 可在你的采购数据里查询。",
    shortage_recovery: values.shortage_source === "simulation" ? "将引用采购单 " + latestScenario.request_id + " 的本次断供结果。" : "按采购请求填写当前缺口和可用预算。",
    quote_delivery:latestScenario ? "比较 0、3、5、7、10 天及自定义窗口，沿用断供评估日和已分配采购量。"
      : "先在「断供模拟」生成重优化报告，再回来评估剩余缺口。",
  };
  $("form-hint").textContent = hints[active.id];
  $("example").hidden = fromDisruption && !latestScenario;
  syncRunButton();
}

function sidebar(open) {
  const mobile = matchMedia("(max-width:750px)").matches;
  document.body.classList.toggle("sidebar-open", mobile && open);
  document.body.classList.toggle("sidebar-closed", !mobile && !open);
  $("backdrop").hidden = !mobile || !open;
  $("toggle-sidebar").setAttribute("aria-expanded", String(open));
}

function selectFeature(id) {
  const next = features.find(f => f.id === id);
  if (!next) return;
  active = next;
  if (id === "quote_delivery") values.request_id = latestScenario?.request_id || values.request_id;
  for (const button of $("features").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.feature === id));
  $("crumb").textContent = next.short;
  $("form-title").textContent = next.short;
  $("title").innerHTML = esc(next.title) + "<span>" + esc(next.tail) + "</span>";
  $("topic-id").textContent = "0" + (features.indexOf(next)+1);
  $("description").textContent = next.desc;
  renderFields();
  if (matchMedia("(max-width:750px)").matches) sidebar(false);
}

function intro() {
  addMessage("assistant", "### 从一张采购单开始\n输入采购请求编号，再从侧栏选择需要的分析。每次提交都会在这里显示单独的结果。", {preview:true});
}

function fillExample() {
  if (active.id === "quote_delivery") {
    values.extension_days = "12";
    renderFields();
    $("fields").querySelector("[name=extension_days]").focus();
    return;
  }
  Object.assign(values, {request_id:"REQ-001", disrupted_supplier_id:demo ? "SUP-001" : "COM-023", disruption_rate:"1",
    shortage_source:"manual", shortage_quantity:"20", remaining_budget:"3200", extension_days:"12"});
  renderFields();
  $("fields").querySelector("[name=request_id]").focus();
}

function syncRunButton() {
  $("run").disabled = !available || busy || (active.id === "quote_delivery" && !latestScenario);
}

function setStatus(online, serviceAvailable = true) {
  demo = !online;
  connecting = false;
  available = serviceAvailable;
  $("status").classList.toggle("live", online);
  $("status").querySelector("span").textContent = online ? "Dify 已配置" : available ? "演示模式" : "连接状态未知";
  syncRunButton();
}

function scrollToEnd() {
  $("scroll").scrollTo({top:$("scroll").scrollHeight,behavior:"smooth"});
}

function appendRecent(text, target) {
  const recent = $("recent");
  if (!recent.querySelector("button")) recent.textContent = "";
  const button = document.createElement("button");
  button.textContent = text;
  button.onclick = () => target.scrollIntoView({behavior:"smooth",block:"start"});
  recent.prepend(button);
}

$("features").innerHTML = features.map(f=>'<button type="button" class="feature" data-feature="'+f.id+'" aria-pressed="false"><span class="feature-icon" style="--tint:'+f.tint+';--accent:'+f.accent+'">'+svg(f.icon)+'</span><span><strong>'+f.short+'</strong><small>'+f.note+'</small></span>'+svg("arrow")+'</button>').join("");
$("features").onclick = event => {const target = event.target.closest("[data-feature]"); if (target) selectFeature(target.dataset.feature);};
$("toggle-sidebar").onclick = () => sidebar($("toggle-sidebar").getAttribute("aria-expanded") !== "true");
$("backdrop").onclick = () => sidebar(false);
const viewport = matchMedia("(max-width:750px)");
viewport.addEventListener("change",()=>sidebar(!viewport.matches));
$("example").onclick = fillExample;
$("new-chat").onclick = () => {
  controller?.abort();
  controller = null;
  busy = false;
  $("run").querySelector("span").textContent = "开始分析";
  latestScenario = null;
  values = {...defaults};
  $("feed").replaceChildren();
  $("recent").textContent = "提交后将在这里显示运行记录";
  selectFeature(features[0].id);
  intro();
  $("scroll").scrollTop = 0;
};
$("fields").addEventListener("input", event => {
  const {name,value} = event.target;
  if (name) values[name] = value;
  if (name === "shortage_source") renderFields();
});
$("run-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || connecting || !available) return;
  const selected = active;
  const requestId = values.request_id.trim().toUpperCase();
  if (!/^REQ-\d{3}$/.test(requestId)) {
    const input = $("fields").querySelector("[name=request_id]");
    input.setCustomValidity("采购请求编号格式应为 REQ-001");
    input.reportValidity();
    input.setCustomValidity("");
    return;
  }
  const payload = Object.fromEntries(new FormData($("run-form")));
  Object.assign(payload, {feature:selected.id,request_id:requestId});
  if (selected.id === "quote_delivery" || payload.shortage_source === "simulation") payload.scenario_token = latestScenario?.token;
  const localController = new AbortController();
  controller = localController;
  const label = requestId + " · " + selected.short;
  addMessage("user", label);
  const wait = addMessage("assistant","正在运行" + selected.short + "…", {preview:true});
  busy = true;
  $("run").disabled = true;
  $("run").querySelector("span").textContent = "分析中…";
  scrollToEnd();
  try {
    const response = await fetch("/api/analyze", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:localController.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "分析请求失败");
    if (controller !== localController) return;
    if (result.scenario_token) {
      latestScenario = {token:result.scenario_token,request_id:requestId,gaps:result.scenario_gaps};
      if (active.id === "quote_delivery") values.request_id = requestId;
      if (["shortage_recovery","quote_delivery"].includes(active.id)) renderFields();
    }
    const answer = addMessage("assistant",result.answer,{sample:result.demo,scenario:result.scenario_token ? latestScenario : null,
      charts:result.charts,advice:result.advice,report:result.report,requestId});
    appendRecent(label, answer);
  } catch (error) {
    if (error.name !== "AbortError" && controller === localController) {
      addMessage("assistant",error.message || "分析暂时失败，请稍后再试。",{error:true});
    }
  } finally {
    wait.remove();
    if (controller === localController) {
      busy = false;
      syncRunButton();
      $("run").querySelector("span").textContent = "开始分析";
      scrollToEnd();
    }
  }
});

sidebar(!viewport.matches);
selectFeature(features[0].id);
intro();
$("run").disabled = true;
try {
  const response = await fetch("/api/status", {cache:"no-store"});
  if (!response.ok) throw new Error();
  const config = await response.json();
  setStatus(config.mode === "live");
  if (demo) {
    addMessage("assistant", "### 演示数据预览\n可先点「填入示例」再开始分析，体验五个功能的输入和结果。", {sample:true,preview:true});
  }
} catch {
  setStatus(false, false);
  addMessage("assistant", "服务暂时不可用。请刷新页面重新检查连接。", {error:true});
}

