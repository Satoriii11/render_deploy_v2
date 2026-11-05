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
let procurementOptions = [];
let supplierOptions = [];
let supplierOptionsRequestId = "";
let supplierLoading = false;
let optionsReady = false;
let optionsError = "";
const supplierCache = new Map();
const supplierPending = new Map();
const comboLabels = {request_id:"", disrupted_supplier_id:""};
const comboQueries = {request_id:"", disrupted_supplier_id:""};

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
      parts.push('<div class="table-frame"><div class="table-viewport" tabindex="0" aria-label="数据表格，可上下滚动"><table><thead><tr>' + cells(line).map(x=>"<th>"+x+"</th>").join("") + "</tr></thead><tbody>");
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        parts.push("<tr>"+cells(lines[i]).map(x=>"<td>"+x+"</td>").join("")+"</tr>");
        i++;
      }
      i--;
      parts.push('</tbody></table></div><div class="table-x-track" role="scrollbar" aria-label="表格横向滚动" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"><div class="table-x-thumb"></div></div></div>');
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

// Fixed-height table with a continuously visible, draggable horizontal scrollbar.
function enableTableFrames(scope) {
  for (const frame of scope.querySelectorAll(".table-frame")) {
    const viewport=frame.querySelector(".table-viewport");
    const track=frame.querySelector(".table-x-track");
    const thumb=track.querySelector(".table-x-thumb");
    const table=viewport.querySelector("table");
    const sync=()=>{
      const maxScroll=Math.max(0,viewport.scrollWidth-viewport.clientWidth);
      const ratio=viewport.clientWidth/Math.max(1,viewport.scrollWidth);
      const trackW=track.clientWidth;
      const thumbW=Math.max(28,Math.min(trackW,trackW*ratio));
      const left=maxScroll?viewport.scrollLeft/maxScroll*(trackW-thumbW):0;
      thumb.style.width=thumbW+"px";
      thumb.style.left=left+"px";
      track.classList.toggle("no-overflow",maxScroll<1);
      track.setAttribute("aria-valuenow",String(maxScroll?Math.round(viewport.scrollLeft/maxScroll*100):0));
      track.setAttribute("aria-valuetext",maxScroll?"已查看横向内容的"+Math.round(viewport.scrollLeft/maxScroll*100)+"%":"表格全部可见");
    };
    viewport.addEventListener("scroll",sync,{passive:true});
    track.addEventListener("pointerdown",event=>{
      const maxScroll=Math.max(0,viewport.scrollWidth-viewport.clientWidth);
      if (!maxScroll) return;
      event.preventDefault();
      const trackRect=track.getBoundingClientRect();
      const thumbRect=thumb.getBoundingClientRect();
      const dragThumb=event.target===thumb;
      const dragOffset=dragThumb?event.clientX-thumbRect.left:thumbRect.width/2;
      const move=clientX=>{
        const travel=Math.max(1,trackRect.width-thumbRect.width);
        const next=Math.max(0,Math.min(travel,clientX-trackRect.left-dragOffset));
        viewport.scrollLeft=next/travel*maxScroll;
        sync();
      };
      move(event.clientX);
      track.setPointerCapture(event.pointerId);
      const onMove=e=>move(e.clientX);
      const onUp=e=>{
        try{track.releasePointerCapture(e.pointerId);}catch{}
        track.removeEventListener("pointermove",onMove);
        track.removeEventListener("pointerup",onUp);
        track.removeEventListener("pointercancel",onUp);
      };
      track.addEventListener("pointermove",onMove);
      track.addEventListener("pointerup",onUp);
      track.addEventListener("pointercancel",onUp);
    });
    track.addEventListener("keydown",event=>{
      const maxScroll=Math.max(0,viewport.scrollWidth-viewport.clientWidth);
      if (!maxScroll) return;
      let delta=0;
      if (event.key==="ArrowRight") delta=90;
      if (event.key==="ArrowLeft") delta=-90;
      if (event.key==="PageDown") delta=viewport.clientWidth*.8;
      if (event.key==="PageUp") delta=-viewport.clientWidth*.8;
      if (event.key==="Home") delta=-maxScroll;
      if (event.key==="End") delta=maxScroll;
      if (delta) {event.preventDefault();viewport.scrollLeft=Math.max(0,Math.min(maxScroll,viewport.scrollLeft+delta));sync();}
    });
    if (typeof ResizeObserver!=="undefined") {
      const observer=new ResizeObserver(sync);
      observer.observe(viewport);observer.observe(table);
    }
    requestAnimationFrame(sync);
  }
}

function chartMarkup(charts) {
  const palette = ["#2e806c","#6088ba","#e5a25c","#9177b2","#65a4a0","#c77375","#89966a"];
  const numeric = new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
  const display = (value,unit="") => numeric.format(value) + (unit ? " "+unit : "");
  const chartTitle = value => esc(value || "指标图表");
  const pct = (n,d) => d > 0 ? Math.max(0,n/d) : 0;
  const maxValue = values => Math.max(1,...values.map(p=>Math.max(0,Number(p.value)||0)));
  // Full SVG labels: wrap text into multiple lines rather than truncating with an ellipsis.
  function wrapSvgLabel(value, maxUnits=28) {
    const lines=[];
    let current="", used=0;
    for (const character of Array.from(String(value ?? ""))) {
      const units=/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u.test(character)?2:1;
      if (current && used+units>maxUnits) {lines.push(current);current="";used=0;}
      current+=character;used+=units;
    }
    if (current) lines.push(current);
    return lines.length?lines:["—"];
  }
  function barSvg(chart,points) {
    const labelW=242, left=labelW+12, plot=288, heightUnit=16;
    const prepared=points.map(point=>({...point,labelLines:wrapSvgLabel(point.label)}));
    const heights=prepared.map(point=>Math.max(44,point.labelLines.length*heightUnit+18));
    const h=42+heights.reduce((a,b)=>a+b,0)+16, max=maxValue(points), scale=plot/max;
    let shapes='',cursor=35;
    for (const [index,point] of prepared.entries()) {
      const v=Math.max(0,Number(point.value)||0);
      const rowHeight=heights[index],mid=cursor+rowHeight/2;
      const firstBaseline=mid-(point.labelLines.length-1)*heightUnit/2+4;
      const label=point.labelLines.map((line,i)=>'<tspan x="'+(labelW-6)+'" dy="'+(i?heightUnit:0)+'">'+esc(line)+'</tspan>').join('');
      shapes += '<g><title>'+esc(point.label+" · "+display(v,chart.unit))+'</title>'+
        '<text x="'+(labelW-6)+'" y="'+firstBaseline+'" text-anchor="end" class="svg-label">'+label+'</text>'+
        '<rect x="'+left+'" y="'+(mid-10)+'" width="'+plot+'" height="20" rx="5" fill="#e7eeeb"/>'+
        '<rect x="'+left+'" y="'+(mid-10)+'" width="'+Math.max(v?2:0,v*scale).toFixed(2)+'" height="20" rx="5" fill="'+palette[index%palette.length]+'"/>'+
        '<text x="'+(left+plot+12)+'" y="'+(mid+4)+'" class="svg-value">'+esc(display(v,chart.unit))+'</text></g>';
      cursor+=rowHeight;
    }
    return '<svg class="viz-svg" role="img" aria-label="'+chartTitle(chart.title)+'" viewBox="0 0 650 '+h+'" preserveAspectRatio="xMinYMin meet">'+shapes+'</svg>';
  }
  function lineSvg(chart,points) {
    const width=640,height=260, left=58,right=620,top=24,bottom=204;
    const max=maxValue(points)*1.08;
    const xs=points.map((p,i)=>Number.isFinite(Number(p.x)) ? Number(p.x) : i);
    const xmin=Math.min(...xs),xmax=Math.max(...xs),range=Math.max(1,xmax-xmin);
    const xCoord=x=>left+(x-xmin)/range*(right-left);
    const yCoord=y=>bottom-Math.max(0,Number(y)||0)/max*(bottom-top);
    const poly=points.map((p,i)=>(i?'L':'M')+xCoord(xs[i]).toFixed(1)+' '+yCoord(p.value).toFixed(1)).join(' ');
    let shapes='';
    for (let i=0;i<=4;i++) {const v=max*i/4,y=yCoord(v);shapes+='<line x1="'+left+'" x2="'+right+'" y1="'+y+'" y2="'+y+'" stroke="#e6ebe7"/><text x="'+(left-9)+'" y="'+(y+4)+'" text-anchor="end" class="svg-tick">'+esc(numeric.format(v))+'</text>';}
    shapes+='<path d="'+poly+'" fill="none" stroke="#2e806c" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>';
    const stride=Math.max(1,Math.ceil(points.length/9));
    points.forEach((p,i)=>{const x=xCoord(xs[i]),y=yCoord(p.value);
      shapes+='<g><title>'+esc(p.label+": "+display(p.value,chart.unit))+'</title><circle cx="'+x+'" cy="'+y+'" r="4.5" fill="#fff" stroke="#2e806c" stroke-width="2.5"/>'+
        (i%stride===0||i===points.length-1 ? '<text x="'+x+'" y="'+(bottom+22)+'" text-anchor="middle" class="svg-tick">'+esc(p.label)+'</text>':'')+'</g>';});
    return '<svg class="viz-svg" role="img" aria-label="'+chartTitle(chart.title)+'" viewBox="0 0 '+width+' '+height+'">'+shapes+'</svg>';
  }
  function donutSvg(chart,points) {
    const r=76,c=2*Math.PI*r, total=points.reduce((s,p)=>s+Math.max(0,Number(p.value)||0),0);
    let offset=0, circles='';
    for (const [i,p] of points.entries()) {
      const share=pct(Number(p.value),total),length=share*c;
      circles+='<circle cx="116" cy="116" r="'+r+'" fill="none" stroke="'+palette[i%palette.length]+'" stroke-width="27" stroke-dasharray="'+length.toFixed(2)+' '+Math.max(0,c-length).toFixed(2)+'" stroke-dashoffset="'+(-offset).toFixed(2)+'" transform="rotate(-90 116 116)"><title>'+esc(p.label+" · "+display(p.value,chart.unit))+'</title></circle>';
      offset+=length;
    }
    const legend=points.map((p,i)=>'<div class="donut-legend-row"><i style="background:'+palette[i%palette.length]+'"></i><span>'+esc(p.label)+'</span><b>'+esc(display(p.value,chart.unit))+'</b></div>').join('');
    return '<div class="donut-layout"><svg class="donut-svg" viewBox="0 0 232 232" role="img" aria-label="'+chartTitle(chart.title)+'"><circle cx="116" cy="116" r="'+r+'" fill="none" stroke="#e9eeea" stroke-width="27"/>'+circles+'<text x="116" y="110" text-anchor="middle" class="donut-total">'+esc(numeric.format(total))+'</text><text x="116" y="134" text-anchor="middle" class="donut-caption">'+esc(chart.unit||"合计")+'</text></svg><div class="donut-legend">'+legend+'</div></div>';
  }
  // Structured business views keep each optimization scheme visually separate.
  function splitBarView(chart) {
    const panels=(chart.plans||[]).map(plan=>{
      const points=(plan.points||[]).filter(x=>Number.isFinite(Number(x.value)));
      return '<section class="allocation-subcard"><h4>'+esc(plan.label)+'方案</h4>'+
        (points.length?'<div class="chart-plot-viewport">'+barSvg({...chart,title:plan.label+"方案",unit:chart.unit},points)+'</div>':'<p class="viz-empty">该方案暂无供应商分配记录。</p>')+
        '</section>';
    });
    return '<div class="allocation-grid">'+panels.join('')+'</div>';
  }
  function fulfillmentView(chart) {
    const panels=(chart.plans||[]).map(plan=>{
      const total=Math.max(0,Number(plan.total)||0),filled=Math.min(total,Math.max(0,Number(plan.fulfilled)||0));
      const missing=Math.max(0,total-filled), percent=total?100*filled/total:0;
      return '<section class="fulfillment-panel"><h4>'+esc(plan.label)+'方案</h4>'+
        '<div class="fulfillment-progress" role="progressbar" aria-label="'+esc(plan.label)+'方案的保障比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+percent.toFixed(2)+'"><span style="width:'+percent.toFixed(2)+'%"></span></div>'+
        '<div class="fulfillment-stats"><span>总需求 <strong>'+esc(display(total,"件"))+'</strong></span><span>可保障 <strong>'+esc(display(filled,"件"))+'</strong></span><span>剩余缺口 <strong>'+esc(display(missing,"件"))+'</strong></span><span>满足率 <strong>'+percent.toFixed(1)+'%</strong></span></div>'+
        '</section>';
    });
    return '<div class="fulfillment-grid">'+panels.join('')+'</div>';
  }
  function efficiencyView(chart) {
    const usable = value=>value!==null&&value!==undefined&&value!==""&&Number.isFinite(Number(value));
    const fmtUnit = value=>usable(value)?numeric.format(Number(value))+" 元/件":"—";
    const fmtPercent = value=>usable(value)?Number(value).toFixed(1)+"%":"—";
    const panels=(chart.plans||[]).map(plan=>{
      const row=(label,info)=>{
        const fulfilled=usable(info.fulfilled)?display(info.fulfilled,"件"):"—";
        const shortage=usable(info.shortage)?display(info.shortage,"件"):"—";
        return '<tr><th scope="row">'+label+'</th><td>'+esc(display(plan.demand,"件"))+'</td><td>'+esc(fulfilled)+'</td><td>'+esc(shortage)+'</td><td>'+esc(fmtPercent(info.rate))+'</td><td>'+esc(fmtUnit(info.unitCost))+'</td></tr>';
      };
      const rateBar=(label,info)=>{
        const known=usable(info.rate),rate=known?Math.max(0,Math.min(100,Number(info.rate))):0;
        return '<div class="efficiency-bar-row"><span>'+label+'</span><div class="efficiency-bar-track" role="meter" aria-label="'+esc(plan.label+label)+'满足率" aria-valuemin="0" aria-valuemax="100" '+(known?'aria-valuenow="'+rate.toFixed(2)+'"':'aria-valuetext="暂无有效数据"')+'><i style="width:'+rate.toFixed(2)+'%"></i></div><b>'+esc(fmtPercent(info.rate))+'</b></div>';
      };
      return '<section class="efficiency-subcard"><h4>'+esc(plan.label)+'方案</h4><div class="efficiency-bars">'+rateBar('断供前',plan.before||{})+rateBar('断供后',plan.after||{})+'</div><div class="efficiency-table-wrap"><table><thead><tr><th>情景</th><th>总需求</th><th>已保障</th><th>缺口</th><th>满足率</th><th>单位保障成本</th></tr></thead><tbody>'+row('断供前',plan.before||{})+row('断供后',plan.after||{})+'</tbody></table></div></section>';
    });
    return '<div class="efficiency-grid">'+panels.join('')+'</div>';
  }
  function reasonGroupView(chart) {
    const groups=Array.isArray(chart.groups)?chart.groups:[];
    const peak=Math.max(1,...groups.map(item=>Number(item.count)||0));
    return '<div class="reason-groups">'+groups.map(group=>{
      const value=Math.max(0,Number(group.count)||0);
      return '<section class="reason-group"><div class="reason-group-heading"><strong>'+esc(group.category)+'</strong><span>'+esc(display(value,"条报价"))+'</span></div>'+
        '<div class="reason-group-meter" aria-hidden="true"><span style="width:'+(value/peak*100).toFixed(2)+'%"></span></div>'+
        '<div class="reason-group-companies"><b>涉及企业</b><div>'+((group.companies||[]).map(name=>'<span class="reason-company">'+esc(name)+'</span>').join('')||'<span>企业信息待核实</span>')+'</div></div>'+
        '</section>';
    }).join('')+'</div><p class="reason-group-note">同一报价可能涉及多个原因类别，类别数量不可直接求和。</p>';
  }
  const cards=(Array.isArray(charts)?charts:[]).map(chart=>{
    const type=chart.type || "bar";
    const points=(Array.isArray(chart.points)?chart.points:[]).filter(point=>Number.isFinite(Number(point.value)));
    if (!points.length && !["splitBar","fulfillment","efficiency","reasonGroups"].includes(type)) return '';
    const body= type==="splitBar" ? splitBarView(chart) : type==="fulfillment" ? fulfillmentView(chart) :
      type==="efficiency" ? efficiencyView(chart) : type==="reasonGroups" ? reasonGroupView(chart) :
      type==="line" ? lineSvg(chart,points) : type==="donut" ? donutSvg(chart,points) :
      '<div class="chart-plot-viewport">'+barSvg(chart,points)+'</div>';
    return '<figure class="metric-chart chart-'+type+'"><figcaption>'+chartTitle(chart.title)+'</figcaption>'+body+'</figure>';
  }).filter(Boolean);
  return cards.length?'<section class="metric-grid" aria-label="统计图表">'+cards.join('')+'</section>':'';
}

function kpiMarkup(kpis) {
  if (!Array.isArray(kpis)||!kpis.length) return "";
  return '<section class="kpi-grid" aria-label="关键采购指标">'+kpis.map(item=>
    '<div class="kpi-card"><span>'+esc(item.label)+'</span><strong>'+esc(item.value)+'</strong>'+
    (item.note?'<small>'+esc(item.note)+'</small>':'')+'</div>').join('')+'</section>';
}

function scenarioAction(label, scenario, feature) {
  const action = document.createElement("button");
  action.type = "button";
  action.innerHTML = svg("arrow") + esc(label);
  action.onclick = () => {
    latestScenario = scenario;
    values.request_id = scenario.request_id;
    const request = procurementOptions.find(item => item.id === scenario.request_id);
    comboLabels.request_id = request ? requestLabel(request) : "本次断供采购需求";
    comboQueries.request_id = comboLabels.request_id;
    values.shortage_source = "simulation";
    values.scenario_plan = scenario.gaps?.cost > 0 ? "cost" : "risk";
    selectFeature(feature);
    $("fields").querySelector("select, input:not([readonly]):not([disabled])")?.focus();
  };
  return action;
}

function addMessage(role, text, {sample=false, error=false, scenario=null, preview=false, charts, kpis, advice, report=false, requestName}={}) {
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
    const kpiSection = kpiMarkup(kpis);
    if (kpiSection) body.insertAdjacentHTML("afterend",kpiSection);
    if (chartSection) bubble.insertAdjacentHTML("beforeend",chartSection);
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
      const fileBase = String(requestName || "采购需求").replace(/[\\/:*?"<>|]/g,"_").replace(/\s+/g," ").slice(0,80);
      download.download = fileBase + "-断供重优化决策报告.md";
      download.href = "#";
      download.onclick = event => {
        event.preventDefault();
        const href = URL.createObjectURL(new Blob([reportText],{type:"text/markdown;charset=utf-8"}));
        const file = Object.assign(document.createElement("a"),{href,download:download.download});
        file.click();
        setTimeout(()=>URL.revokeObjectURL(href),1000);
      };
      tools.append(download);
      const visual = document.createElement("button");
      visual.type = "button";
      visual.innerHTML = svg("copy") + "下载图文报告";
      visual.onclick = () => {
        const content = bubble.cloneNode(true);
        content.querySelector(".message-tools")?.remove();
        const style = `@page{size:A4;margin:17mm}body{font:13px/1.7 "Microsoft YaHei",sans-serif;color:#1d3540;margin:0 auto;max-width:950px}h3{color:#295c51;margin-top:20px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #dae5da;padding:6px;text-align:left}th{background:#edf4ed}.table-wrap{overflow-wrap:break-word;margin:12px 0;overflow-x:auto}.kpi-grid{display:flex;gap:10px;flex-wrap:wrap}.kpi-card{padding:10px;border:1px solid #dfe8df;border-radius:8px}.kpi-card span,.kpi-card strong{display:block}.kpi-card strong{font-size:20px;color:#2e806c}.metric-grid{display:grid;grid-template-columns:1fr;gap:12px}.metric-chart{border:1px solid #e1e9e1;padding:12px;break-inside:avoid;margin:10px 0}.metric-chart figcaption{font-weight:bold}.viz-svg{width:100%;max-height:680px}.svg-label,.svg-value{font-size:11px;fill:#38534d}.svg-tick{font-size:10px;fill:#77867e}.donut-layout{display:flex;gap:18px;align-items:center}.donut-svg{width:190px}.donut-total{font-size:29px;font-weight:bold}.donut-caption{font-size:12px}.donut-legend{flex:1}.donut-legend-row{display:flex;gap:8px;margin:6px 0}.donut-legend-row i{display:block;width:10px;height:10px;flex:none}.donut-legend-row b{margin-left:auto}.purchase-advice{margin-top:12px;padding:10px;border-left:3px solid #2e806c;background:#f3f7f4}.message-meta{color:#55786a;font-size:12px;margin-bottom:10px}.sample-mark{color:#986833}.table-frame{margin:10px 0;overflow:visible;border:0}.table-viewport{max-height:none!important;overflow:visible!important}.table-x-track{display:none!important}.table-frame table{width:100%;table-layout:fixed;white-space:normal!important;font-size:9px}.table-frame th,.table-frame td{white-space:normal!important;overflow-wrap:anywhere;word-break:break-word;min-width:0!important;max-width:none!important;vertical-align:top}.chart-plot-viewport{max-height:none!important;overflow:visible!important}.viz-svg{max-height:none!important}.allocation-grid,.fulfillment-grid,.efficiency-grid{display:grid;grid-template-columns:1fr;gap:12px}.allocation-subcard,.fulfillment-panel,.efficiency-subcard,.reason-group{padding:12px;border:1px solid #d8e8dd;border-radius:9px;break-inside:avoid}.fulfillment-progress,.reason-group-meter{height:18px;background:#e6eee9;border-radius:9px;overflow:hidden}.fulfillment-progress span,.reason-group-meter span{display:block;height:100%;background:#2e806c}.fulfillment-stats{display:flex;flex-wrap:wrap;gap:15px;margin-top:10px}.reason-group-companies div{display:flex;flex-wrap:wrap;gap:5px}.reason-company{display:inline-block;padding:3px 8px;background:#eaf2ec;border-radius:5px}.efficiency-table-wrap table{width:100%;font-size:10px}.efficiency-bar-track{height:10px;background:#e2ede6;border-radius:6px}.efficiency-bar-track i{display:block;height:100%;background:#2e806c}.efficiency-bar-row{display:grid;grid-template-columns:60px 1fr 60px;gap:8px;align-items:center}`;
        const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>采策采购决策分析</title><style>'+style+'</style></head><body>'+content.innerHTML+'</body></html>';
        const href = URL.createObjectURL(new Blob([html],{type:"text/html;charset=utf-8"}));
        const file = Object.assign(document.createElement("a"),{href,download:fileBase+"-图文决策报告.html"});
        file.click();
        setTimeout(()=>URL.revokeObjectURL(href),1000);
      };
      tools.append(visual);
    }
    if (scenario && Object.values(scenario.gaps ?? {}).some(gap=>gap > 0)) {
      tools.append(scenarioAction("测算延期能否补齐",scenario,"quote_delivery"),
        scenarioAction("评估缺口和替代料",scenario,"shortage_recovery"));
    }
    bubble.append(tools);
  }
  $("feed").append(row);
  enableTableFrames(row);
  return row;
}

function field(name, label, attrs="", options=null) {
  const value = esc(values[name] ?? "");
  const control = options ? '<select name="'+name+'">'+options.map(([v,l])=>'<option value="'+v+'" '+(v===values[name]?"selected":"")+'>'+esc(l)+'</option>').join("")+'</select>'
    : '<input name="'+name+'" value="'+value+'" '+attrs+'>';
  return '<label class="field"><span>'+esc(label)+'</span>'+control+'</label>';
}

function requestLabel(option) {
  return option.company + " · " + option.product + " · " + option.quantity + "件";
}

// Shared full-screen picker for procurement requests AND valid suppliers.
let pickerMode="request";
let requestPickerMatches=[];
let requestPickerActive=-1;
let requestPickerFocusReturn=null;
function openRequestPicker(mode="request") {
  if (!optionsReady) return;
  if (mode==="supplier" && (!values.request_id || supplierLoading || supplierOptionsRequestId!==values.request_id || !supplierOptions.length)) return;
  pickerMode=mode;
  requestPickerFocusReturn=document.activeElement;
  const modal=$("request-picker");
  modal.hidden=false;
  document.body.classList.add("request-picker-open");
  $("fields").querySelector('[data-request-picker-open="'+mode+'"]')?.setAttribute("aria-expanded","true");
  const isSupplier=mode==="supplier";
  $("request-picker-heading").textContent=isSupplier?"选择断供企业":"选择采购需求";
  $("request-picker-description").textContent=isSupplier?"仅显示当前采购需求下的有效候选企业":"搜索企业或产品，也可以浏览全部采购需求";
  $("request-picker-search-label").textContent=isSupplier?"搜索供应商名称":"搜索公司或产品";
  $("request-picker-search").placeholder=isSupplier?"例如：长电、三环、蓝普":"例如：南京普天、贴片电阻、10kΩ";
  $("request-picker-show-all").setAttribute("aria-label",isSupplier?"展开全部候选供应商":"展开全部采购需求");
  $("request-picker-options").setAttribute("aria-label",isSupplier?"候选供应商列表":"采购需求列表");
  $("request-picker-search").value="";
  requestPickerActive=-1;
  renderRequestPicker();
  $("request-picker-search").focus();
}
function closeRequestPicker() {
  const modal=$("request-picker");
  if (!modal || modal.hidden) return;
  modal.hidden=true;
  document.body.classList.remove("request-picker-open");
  $("fields").querySelectorAll("[data-request-picker-open]").forEach(el=>el.setAttribute("aria-expanded","false"));
  const target=requestPickerFocusReturn;
  requestPickerFocusReturn=null;
  if (target?.isConnected && typeof target.focus==="function") target.focus();
  else $("fields").querySelector('[data-request-picker-open="'+pickerMode+'"]')?.focus();
}
function renderRequestPicker() {
  const query=$("request-picker-search").value.trim();
  const isSupplier=pickerMode==="supplier";
  const options=isSupplier?supplierOptions:procurementOptions;
  requestPickerMatches=options.filter(item=>fuzzyMatch(query,isSupplier?[item.name]:[item.company,item.product,requestLabel(item)]));
  const list=$("request-picker-options");
  const type=isSupplier?"家候选企业":"条采购需求";
  $("request-picker-count").textContent=(query?"匹配 ":"全部 ")+requestPickerMatches.length+" "+type;
  if (requestPickerActive>=requestPickerMatches.length) requestPickerActive=-1;
  const selectedId=isSupplier?values.disrupted_supplier_id:values.request_id;
  list.innerHTML=requestPickerMatches.length?requestPickerMatches.map((item,index)=>
    '<button type="button" class="request-picker-option'+(selectedId===item.id?' is-selected':'')+(index===requestPickerActive?' is-active':'')+'" data-request-picker-index="'+index+'" role="option" aria-selected="'+(selectedId===item.id)+'">'+
    '<span class="request-picker-option-main">'+esc(isSupplier?item.name:item.company)+'</span>'+
    (isSupplier?'':'<span class="request-picker-option-sub">'+esc(item.product)+' · '+esc(item.quantity)+'件</span>')+
    (selectedId===item.id?'<span class="request-picker-selected">已选择</span>':'')+'</button>').join('')
    :'<div class="request-picker-empty">'+(isSupplier?'当前候选企业中没有匹配项，请更换企业关键词。':'没有匹配的采购需求，请尝试公司名称、产品名称或其中的关键词。')+'</div>';
  list.setAttribute("aria-busy","false");
}
function selectRequestPickerOption(index) {
  const option=requestPickerMatches[index];
  if (!option) return;
  if (pickerMode==="supplier") {
    // Only a member of the API-vetted supplier list is accepted.
    if (supplierOptionsRequestId!==values.request_id || !supplierOptions.some(item=>item.id===option.id)) return;
    applySupplierOption(null,option);
    renderFields();
    closeRequestPicker();
  } else applyRequestOption(option);
}

function searchKey(value) {
  return String(value ?? "").toLocaleLowerCase("zh-CN").replace(/[\s·,，、。；;：:()（）\-_/]+/g, "");
}

function fuzzyMatch(query, candidates) {
  const q = searchKey(query);
  if (!q) return true;
  return candidates.some(value => {
    const candidate = searchKey(value);
    if (candidate.includes(q)) return true;
    let position = 0;
    for (const char of q) {
      position = candidate.indexOf(char, position);
      if (position < 0) return false;
      position++;
    }
    return true;
  });
}

function comboOptions(name) {
  return name === "request_id" ? procurementOptions : supplierOptions;
}

function comboSearchText(name, option) {
  return name === "request_id"
    ? [option.company, option.product, requestLabel(option)]
    : [option.name];
}

function requestPickerField({locked=false}={}) {
  const selected=procurementOptions.find(option=>option.id===values.request_id);
  const main=selected?.company || (locked ? "请先运行断供模拟" : optionsReady ? "点击选择采购需求" : "正在读取采购需求…");
  const sub=selected?selected.product+" · "+selected.quantity+"件":(locked?"与本次断供情景关联":"支持搜索企业或产品，并可展开浏览全部选项");
  const disabled=locked || !optionsReady;
  return '<div class="field request-picker-field"><span>采购需求</span>'+
    '<button class="request-picker-trigger" type="button" data-request-picker-open="request" aria-haspopup="dialog" aria-controls="request-picker" aria-expanded="false" '+(disabled?'disabled':'')+'>'+
    '<span class="request-picker-text"><strong>'+esc(main)+'</strong><small>'+esc(sub)+'</small></span>'+
    '<span class="request-picker-arrow" aria-hidden="true">'+(locked?'🔒':'⌄')+'</span></button>'+
    '<input type="hidden" name="request_id" value="'+esc(values.request_id)+'"></div>';
}

function supplierPickerField() {
  const option=supplierOptions.find(item=>item.id===values.disrupted_supplier_id);
  const disabled=!optionsReady || !values.request_id || supplierLoading || supplierOptionsRequestId!==values.request_id || !supplierOptions.length;
  const name=option?.name || (!values.request_id?"请先选择采购需求":supplierLoading?"正在读取当前需求的候选企业…":!supplierOptions.length?"当前采购需求暂无可选供应商":"点击选择断供企业");
  return '<div class="field request-picker-field supplier-picker-field"><span>断供企业</span>'+
    '<button class="request-picker-trigger" type="button" data-request-picker-open="supplier" aria-haspopup="dialog" aria-controls="request-picker" aria-expanded="false" '+(disabled?'disabled':'')+'>'+
    '<span class="request-picker-text"><strong>'+esc(name)+'</strong><small>'+esc(option?"已选择当前采购需求的有效候选供应商":"支持模糊搜索企业名称或浏览完整候选列表")+'</small></span>'+
    '<span class="request-picker-arrow" aria-hidden="true">⌄</span></button>'+
    '<input type="hidden" name="disrupted_supplier_id" value="'+esc(values.disrupted_supplier_id)+'"></div>';
}

function comboField(name, label, {locked=false, placeholder=""}={}) {
  const isRequest = name === "request_id";
  const selectedId = values[name] || "";
  const selected = isRequest
    ? procurementOptions.find(item => item.id === selectedId)
    : supplierOptions.find(item => item.id === selectedId);
  const selectedText = comboLabels[name] || (selected ? (isRequest ? requestLabel(selected) : selected.name) : "");
  const query = comboQueries[name] || selectedText;
  const unavailable = !optionsReady || (name === "disrupted_supplier_id" && (!values.request_id || supplierLoading || supplierOptionsRequestId !== values.request_id || supplierOptions.length === 0));
  const disabled = locked || unavailable;
  const defaultPlaceholder = isRequest
    ? (optionsReady ? "搜索企业或产品名称，也可展开查看" : "正在读取采购需求…")
    : (!values.request_id ? "请先选择采购需求" : supplierLoading ? "正在读取候选供应商…" : supplierOptions.length ? "搜索或展开当前需求的候选企业" : "当前采购需求暂无有效候选企业");
  const value = locked ? (selectedText || (latestScenario ? "本次断供采购需求" : "先运行断供模拟")) : query;
  const id = "combo-list-" + name;
  return '<div class="field combo-field"><span>'+esc(label)+'</span>' +
    '<div class="combo" data-combo-root="'+name+'">' +
      '<div class="combo-control">' +
        '<input class="combo-input" type="text" data-combo-input="'+name+'" value="'+esc(value)+'" placeholder="'+esc(placeholder || defaultPlaceholder)+'" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="'+id+'" '+(disabled?'disabled':'')+(locked?' readonly':'')+'>' +
        '<button class="combo-toggle" type="button" data-combo-toggle="'+name+'" aria-label="展开'+esc(label)+'选项" aria-expanded="false" '+(disabled?'disabled':'')+'>▾</button>' +
      '</div>' +
      '<input type="hidden" name="'+name+'" data-combo-value="'+name+'" value="'+esc(selectedId)+'">' +
      '<div class="combo-menu" id="'+id+'" role="listbox" hidden></div>' +
    '</div></div>';
}

function closeCombo(root) {
  if (!root) return;
  const input = root.querySelector("[data-combo-input]");
  const toggle = root.querySelector("[data-combo-toggle]");
  const menu = root.querySelector(".combo-menu");
  menu.hidden = true;
  root.classList.remove("is-open");
  input?.setAttribute("aria-expanded", "false");
  toggle?.setAttribute("aria-expanded", "false");
  root._activeIndex = -1;
}

function renderComboMenu(root) {
  const name = root.dataset.comboRoot;
  const input = root.querySelector("[data-combo-input]");
  const menu = root.querySelector(".combo-menu");
  const options = comboOptions(name);
  const rawQuery = input.value.trim();
  const query = rawQuery === comboLabels[name] ? "" : rawQuery;
  const matches = options.map((option,index)=>({option,index}))
    .filter(({option})=>fuzzyMatch(query,comboSearchText(name,option)));
  root._filteredOptions = matches.map(item=>item.option);
  root._activeIndex = matches.length ? Math.min(root._activeIndex ?? -1,matches.length-1) : -1;
  if (!options.length) {
    const message = name === "disrupted_supplier_id"
      ? (supplierLoading ? "正在读取候选供应商…" : "请先选择采购需求，系统将读取其有效候选企业。")
      : (optionsError || "暂无可选采购需求。");
    menu.innerHTML = '<div class="combo-empty">'+esc(message)+'</div>';
    return;
  }
  if (!matches.length) {
    menu.innerHTML = '<div class="combo-empty">没有找到匹配项。请尝试其他关键词，或从下拉列表选择。</div>';
    return;
  }
  menu.innerHTML = matches.map(({option,index},visibleIndex)=>{
    const selected = values[name] === option.id;
    const activeClass = visibleIndex === root._activeIndex ? " is-active" : "";
    if (name === "request_id") {
      return '<button type="button" class="combo-option'+activeClass+'" role="option" aria-selected="'+selected+'" data-option-index="'+visibleIndex+'">' +
        '<span class="combo-option-main">'+esc(option.company)+'</span>' +
        '<span class="combo-option-sub">'+esc(option.product)+' · '+esc(option.quantity)+'件</span></button>';
    }
    return '<button type="button" class="combo-option'+activeClass+'" role="option" aria-selected="'+selected+'" data-option-index="'+visibleIndex+'"><span class="combo-option-main">'+esc(option.name)+'</span></button>';
  }).join("");
}

function openCombo(root) {
  if (!root) return;
  const input = root.querySelector("[data-combo-input]");
  if (!input || input.disabled || input.readOnly) return;
  renderComboMenu(root);
  const menu = root.querySelector(".combo-menu");
  const toggle = root.querySelector("[data-combo-toggle]");
  menu.hidden = false;
  root.classList.add("is-open");
  input.setAttribute("aria-expanded", "true");
  toggle?.setAttribute("aria-expanded", "true");
}

function clearSupplierSelection() {
  values.disrupted_supplier_id = "";
  comboLabels.disrupted_supplier_id = "";
  comboQueries.disrupted_supplier_id = "";
  supplierOptions = [];
  supplierOptionsRequestId = "";
  supplierLoading = false;
  const hidden = $("fields").querySelector('[data-combo-value="disrupted_supplier_id"]');
  const input = $("fields").querySelector('[data-combo-input="disrupted_supplier_id"]');
  if (hidden) hidden.value = "";
  if (input) {input.value = ""; input.disabled = true; input.placeholder = "请先选择采购需求";}
}

async function loadSupplierOptions(requestId, {rerender=true}={}) {
  if (!requestId) return [];
  if (supplierCache.has(requestId)) {
    supplierOptions = supplierCache.get(requestId).map(item=>({...item}));
    supplierOptionsRequestId = requestId;
    supplierLoading = false;
    if (rerender && active.id === "disruption_sim") renderFields();
    syncRunButton();
    return supplierOptions;
  }
  if (supplierPending.has(requestId)) {
    try {
      const pending = await supplierPending.get(requestId);
      if (values.request_id === requestId) {
        supplierOptions = pending.map(item=>({...item}));
        supplierOptionsRequestId = requestId;
        supplierLoading = false;
        if (rerender && active.id === "disruption_sim") renderFields();
        syncRunButton();
      }
      return pending;
    } catch (error) {
      if (values.request_id === requestId) {
        supplierOptions = [];
        supplierOptionsRequestId = requestId;
        supplierLoading = false;
        optionsError = error.message || "候选供应商读取失败。";
        if (rerender && active.id === "disruption_sim") renderFields();
        syncRunButton();
      }
      return [];
    }
  }
  supplierLoading = true;
  supplierOptions = [];
  supplierOptionsRequestId = requestId;
  if (rerender && active.id === "disruption_sim") renderFields();
  const pending = (async () => {
    const response = await fetch("/api/options?request_id="+encodeURIComponent(requestId),{cache:"no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "候选供应商读取失败。");
    return Array.isArray(data.suppliers) ? data.suppliers : [];
  })();
  supplierPending.set(requestId,pending);
  try {
    const list = await pending;
    supplierCache.set(requestId,list.map(item=>({...item})));
    if (values.request_id !== requestId) return [];
    supplierOptions = list;
    supplierOptionsRequestId = requestId;
    supplierLoading = false;
    optionsError = "";
    if (values.disrupted_supplier_id && !supplierOptions.some(item=>item.id===values.disrupted_supplier_id)) {
      values.disrupted_supplier_id = "";
      comboLabels.disrupted_supplier_id = "";
      comboQueries.disrupted_supplier_id = "";
    }
    if (rerender && active.id === "disruption_sim") renderFields();
    else syncRunButton();
    return supplierOptions;
  } catch (error) {
    if (values.request_id !== requestId) return [];
    supplierOptions = [];
    supplierOptionsRequestId = requestId;
    supplierLoading = false;
    optionsError = error.message || "候选供应商读取失败。";
    if (rerender && active.id === "disruption_sim") renderFields();
    else syncRunButton();
    return [];
  } finally {
    supplierPending.delete(requestId);
  }
}

function applyRequestOption(option, {preserveScenario=false, rerender=true}={}) {
  const previous = values.request_id;
  values.request_id = option.id;
  comboLabels.request_id = requestLabel(option);
  comboQueries.request_id = comboLabels.request_id;
  if (previous !== option.id && !preserveScenario) {
    latestScenario = null;
    clearSupplierSelection();
    if (values.shortage_source === "simulation") values.shortage_source = "manual";
  }
  if (rerender) renderFields();
  closeRequestPicker();
  if (active.id === "disruption_sim") void loadSupplierOptions(option.id,{rerender:true});
  else syncRunButton();
}

function applySupplierOption(root, option) {
  values.disrupted_supplier_id = option.id;
  comboLabels.disrupted_supplier_id = option.name;
  comboQueries.disrupted_supplier_id = option.name;
  if (root) {
    root.querySelector('[data-combo-input="disrupted_supplier_id"]')?.setAttribute("value",option.name);
    const hidden=root.querySelector('[data-combo-value="disrupted_supplier_id"]');
    if (hidden) hidden.value=option.id;
    closeCombo(root);
  }
  syncRunButton();
}

function selectComboOption(root, visibleIndex) {
  const option = root._filteredOptions?.[visibleIndex];
  if (!option) return;
  const name = root.dataset.comboRoot;
  if (name === "request_id") {
    applyRequestOption(option);
    return;
  }
  applySupplierOption(root,option);
}

function exactComboMatches(name, query) {
  const q = searchKey(query);
  if (!q) return [];
  return comboOptions(name).filter(option => {
    const valuesToMatch = name === "request_id"
      ? [option.company, option.product, requestLabel(option)]
      : [option.name];
    return valuesToMatch.some(value => searchKey(value) === q);
  });
}

function ensureComboSelection(name) {
  const root = $("fields").querySelector('[data-combo-root="'+name+'"]');
  if (!root) return name === "request_id" ? procurementOptions.some(item=>item.id===values.request_id) : true;
  const input = root.querySelector("[data-combo-input]");
  const hidden = root.querySelector("[data-combo-value]");
  if (hidden.value && comboLabels[name] && input.value === comboLabels[name]) return true;
  const matches = exactComboMatches(name,input.value);
  if (matches.length === 1) {
    if (name === "request_id") applyRequestOption(matches[0]);
    else applySupplierOption(root,matches[0]);
    return Boolean(values[name]);
  }
  openCombo(root);
  input.setCustomValidity(matches.length > 1 ? "匹配到多个结果，请从下拉列表中选择具体采购需求。" : "请从下拉列表选择有效的企业或采购需求。");
  input.reportValidity();
  input.setCustomValidity("");
  return false;
}

function renderFields() {
  const fromDisruption = active.id === "quote_delivery";
  const simulationRecovery = active.id === "shortage_recovery" && values.shortage_source === "simulation";
  const requestLocked = fromDisruption || simulationRecovery;
  let fields = requestPickerField({locked:requestLocked});
  if (!fromDisruption) fields += field("evaluation_date","评估日期（选填）",'type="date"');
  if (active.id === "disruption_sim") {
    fields += supplierPickerField();
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
    supplier_risk:"输入企业或产品关键词，选择对应采购需求；也可以展开列表浏览。",
    purchase_optimize:"选择采购企业、产品和需求件数；结果同时给出成本优先和风险优先方案。",
    disruption_sim:"先选择采购需求，再从该需求下的有效候选供应商中选择断供企业。比例填 1 表示完全断供。",
    shortage_recovery: values.shortage_source === "simulation" ? "已锁定本次断供分析对应的采购需求，将引用该情景的重优化结果。" : "选择需要恢复的采购需求，再填写当前缺口和可用预算。",
    quote_delivery:latestScenario ? "已锁定本次断供采购需求；比较 0、3、5、7、10 天及自定义窗口。"
      : "先在「断供模拟」生成重优化报告，再回来评估剩余缺口。",
  };
  $("form-hint").textContent = optionsError || hints[active.id];
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
  if (id === "quote_delivery") values.request_id = latestScenario?.request_id || "";
  if (id === "shortage_recovery" && values.shortage_source === "simulation") values.request_id = latestScenario?.request_id || "";
  const selectedRequest = procurementOptions.find(item=>item.id===values.request_id);
  if (selectedRequest) {
    comboLabels.request_id = requestLabel(selectedRequest);
    comboQueries.request_id = comboLabels.request_id;
  } else if (id === "quote_delivery" || (id === "shortage_recovery" && values.shortage_source === "simulation")) {
    comboLabels.request_id = "";
    comboQueries.request_id = "";
  }
  for (const button of $("features").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.feature === id));
  $("crumb").textContent = next.short;
  $("form-title").textContent = next.short;
  $("title").innerHTML = esc(next.title) + "<span>" + esc(next.tail) + "</span>";
  $("topic-id").textContent = "0" + (features.indexOf(next)+1);
  $("description").textContent = next.desc;
  renderFields();
  if (id === "disruption_sim" && values.request_id && supplierOptionsRequestId !== values.request_id) void loadSupplierOptions(values.request_id,{rerender:true});
  if (matchMedia("(max-width:750px)").matches) sidebar(false);
}

function intro() {
  addMessage("assistant", "### 从一项采购需求开始\n选择采购企业和产品，也可以输入关键词搜索。再从侧栏选择需要的分析。每次提交都会在这里显示单独的结果。", {preview:true});
}

async function fillExample() {
  if (active.id === "quote_delivery") {
    values.extension_days = "12";
    renderFields();
    $("fields").querySelector("[name=extension_days]")?.focus();
    return;
  }
  const request = procurementOptions.find(item=>item.id==="REQ-001") || procurementOptions[0];
  if (!request) {
    addMessage("assistant",optionsError || "采购需求列表尚未加载完成，请稍后重试。",{error:true});
    return;
  }
  Object.assign(values,{evaluation_date:"",disruption_rate:"1",shortage_source:"manual",shortage_quantity:"20",remaining_budget:"3200",extension_days:"12"});
  applyRequestOption(request,{rerender:true});
  if (active.id === "disruption_sim") {
    const candidates = await loadSupplierOptions(request.id,{rerender:true});
    const preferred = candidates.find(item=>item.id==="COM-023") || candidates[0];
    if (preferred) {
      values.disrupted_supplier_id = preferred.id;
      comboLabels.disrupted_supplier_id = preferred.name;
      comboQueries.disrupted_supplier_id = preferred.name;
      renderFields();
    }
  }
  $("fields").querySelector("[data-request-picker-open]")?.focus();
}

function syncRunButton() {
  const requestValid = optionsReady && procurementOptions.some(item=>item.id===values.request_id);
  const scenarioLocked = active.id === "quote_delivery" || (active.id === "shortage_recovery" && values.shortage_source === "simulation");
  const scenarioValid = !scenarioLocked || Boolean(latestScenario && latestScenario.request_id === values.request_id);
  const supplierValid = active.id !== "disruption_sim" || (
    supplierOptionsRequestId === values.request_id && supplierOptions.some(item=>item.id===values.disrupted_supplier_id)
  );
  $("run").disabled = !available || busy || !requestValid || !scenarioValid || !supplierValid;
}

function setStatus(online, serviceAvailable = true) {
  demo = !online;
  connecting = false;
  available = serviceAvailable;
  syncRunButton();
}

async function loadRequestOptions() {
  optionsReady = false;
  optionsError = "";
  renderFields();
  try {
    const response = await fetch("/api/options",{cache:"no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "采购需求读取失败。");
    procurementOptions = Array.isArray(data.requests) ? data.requests : [];
    if (!procurementOptions.length) throw new Error("当前没有可供选择的采购需求。");
    optionsReady = true;
    const selected = procurementOptions.find(item=>item.id===values.request_id);
    if (selected) {
      comboLabels.request_id = requestLabel(selected);
      comboQueries.request_id = comboLabels.request_id;
    }
    if (active.id === "disruption_sim" && values.request_id) await loadSupplierOptions(values.request_id,{rerender:false});
  } catch (error) {
    optionsError = error.message || "采购选项读取失败，请刷新页面重试。";
    optionsReady = false;
  }
  renderFields();
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
$("fields").addEventListener("click",event=>{
  const picker=event.target.closest("[data-request-picker-open]");
  if (picker) openRequestPicker(picker.dataset.requestPickerOpen||"request");
});
$("request-picker-close").addEventListener("click",closeRequestPicker);
$("request-picker-backdrop").addEventListener("click",closeRequestPicker);
$("request-picker-search").addEventListener("input",()=>{requestPickerActive=-1;renderRequestPicker();});
$("request-picker-show-all").addEventListener("click",()=>{
  $("request-picker-search").value="";
  requestPickerActive=-1;
  renderRequestPicker();
  $("request-picker-search").focus();
});
$("request-picker-options").addEventListener("click",event=>{
  const button=event.target.closest("[data-request-picker-index]");
  if (button) selectRequestPickerOption(Number(button.dataset.requestPickerIndex));
});
$("request-picker").addEventListener("keydown",event=>{
  if (event.key==="Escape") {event.preventDefault();closeRequestPicker();return;}
  if (event.key==="Tab") {
    const focusable=[...$("request-picker").querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(element=>element.getClientRects().length);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement===focusable[0]) {event.preventDefault();focusable.at(-1).focus();}
    else if (!event.shiftKey && document.activeElement===focusable.at(-1)) {event.preventDefault();focusable[0].focus();}
  }
  if (event.target!==$("request-picker-search")) return;
  if (event.key==="ArrowDown" || event.key==="ArrowUp") {
    if (!requestPickerMatches.length) return;
    event.preventDefault();
    const step=event.key==="ArrowDown"?1:-1;
    requestPickerActive=(requestPickerActive+step+requestPickerMatches.length)%requestPickerMatches.length;
    renderRequestPicker();
    $("request-picker-options").querySelector(".is-active")?.scrollIntoView({block:"nearest"});
  } else if (event.key==="Enter") {
    event.preventDefault();
    if (requestPickerActive>=0) selectRequestPickerOption(requestPickerActive);
    else if (requestPickerMatches.length===1) selectRequestPickerOption(0);
    else $("request-picker-options").querySelector("[role=option]")?.focus();
  }
});

$("example").onclick = fillExample;
$("new-chat").onclick = () => {
  closeRequestPicker();
  controller?.abort();
  controller = null;
  busy = false;
  $("run").querySelector("span").textContent = "开始分析";
  latestScenario = null;
  values = {...defaults};
  comboLabels.request_id = "";
  comboLabels.disrupted_supplier_id = "";
  comboQueries.request_id = "";
  comboQueries.disrupted_supplier_id = "";
  supplierOptions = [];
  supplierOptionsRequestId = "";
  supplierLoading = false;
  $("feed").replaceChildren();
  $("recent").textContent = "提交后将在这里显示运行记录";
  selectFeature(features[0].id);
  intro();
  if (!optionsReady) void loadRequestOptions();
  $("scroll").scrollTop = 0;
};
$("fields").addEventListener("input", event => {
  const comboInput = event.target.closest("[data-combo-input]");
  if (comboInput) {
    const name = comboInput.dataset.comboInput;
    const root = comboInput.closest("[data-combo-root]");
    comboQueries[name] = comboInput.value;
    const hidden = root.querySelector("[data-combo-value]");
    if (name === "request_id" && values.request_id && comboInput.value !== comboLabels.request_id) {
      values.request_id = "";
      comboLabels.request_id = "";
      hidden.value = "";
      latestScenario = null;
      clearSupplierSelection();
      if (values.shortage_source === "simulation") values.shortage_source = "manual";
    } else if (name === "disrupted_supplier_id" && values.disrupted_supplier_id && comboInput.value !== comboLabels.disrupted_supplier_id) {
      values.disrupted_supplier_id = "";
      comboLabels.disrupted_supplier_id = "";
      hidden.value = "";
    }
    root._activeIndex = -1;
    openCombo(root);
    syncRunButton();
    return;
  }
  const {name,value} = event.target;
  if (name) values[name] = value;
  if (name === "shortage_source") {
    if (value === "simulation" && latestScenario) {
      values.request_id = latestScenario.request_id;
      const request = procurementOptions.find(item=>item.id===values.request_id);
      if (request) comboLabels.request_id = comboQueries.request_id = requestLabel(request);
    }
    renderFields();
  }
});

$("fields").addEventListener("change", event => {
  const {name,value} = event.target;
  if (name && !event.target.matches("[data-combo-input]")) values[name] = value;
  if (name === "shortage_source") {
    if (value === "simulation" && latestScenario) {
      values.request_id = latestScenario.request_id;
      const request = procurementOptions.find(item=>item.id===values.request_id);
      if (request) comboLabels.request_id = comboQueries.request_id = requestLabel(request);
    }
    renderFields();
  }
});

$("fields").addEventListener("click", event => {
  const option = event.target.closest("[data-option-index]");
  if (option) {
    const root = option.closest("[data-combo-root]");
    selectComboOption(root,Number(option.dataset.optionIndex));
    return;
  }
  const toggle = event.target.closest("[data-combo-toggle]");
  if (toggle) {
    const root = toggle.closest("[data-combo-root]");
    const menu = root.querySelector(".combo-menu");
    if (menu.hidden) openCombo(root); else closeCombo(root);
  }
});

$("fields").addEventListener("focusin", event => {
  const input = event.target.closest("[data-combo-input]");
  if (input && !input.disabled && !input.readOnly) {
    if (comboLabels[input.dataset.comboInput] && input.value === comboLabels[input.dataset.comboInput]) input.select();
    openCombo(input.closest("[data-combo-root]"));
  }
});

$("fields").addEventListener("keydown", event => {
  const input = event.target.closest("[data-combo-input]");
  if (!input) return;
  const root = input.closest("[data-combo-root]");
  const menu = root.querySelector(".combo-menu");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (menu.hidden) openCombo(root);
    const count = root._filteredOptions?.length || 0;
    if (count) {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      root._activeIndex = ((root._activeIndex ?? -1) + delta + count) % count;
      renderComboMenu(root);
      menu.querySelectorAll(".combo-option").forEach((item,index)=>item.classList.toggle("is-active",index===root._activeIndex));
      menu.querySelector(".is-active")?.scrollIntoView({block:"nearest"});
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (!menu.hidden && root._activeIndex >= 0) selectComboOption(root,root._activeIndex);
    else {
      const matches = exactComboMatches(root.dataset.comboRoot,input.value);
      if (matches.length === 1) {
        if (root.dataset.comboRoot === "request_id") applyRequestOption(matches[0]);
        else {
          const index = (root._filteredOptions || []).findIndex(item=>item.id===matches[0].id);
          if (index >= 0) selectComboOption(root,index);
        }
      } else openCombo(root);
    }
  } else if (event.key === "Escape") {
    closeCombo(root);
  }
});

document.addEventListener("click", event => {
  if (!event.target.closest("[data-combo-root]")) {
    $("fields").querySelectorAll("[data-combo-root]").forEach(closeCombo);
  }
});
$("run-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || connecting || !available) return;
  const selected = active;
  const requestLocked = selected.id === "quote_delivery" || (selected.id === "shortage_recovery" && values.shortage_source === "simulation");
  if (!requestLocked && !ensureComboSelection("request_id")) return;
  if (selected.id === "disruption_sim" && (supplierOptionsRequestId!==values.request_id || !supplierOptions.some(item=>item.id===values.disrupted_supplier_id))) {
    openRequestPicker("supplier");return;
  }
  const requestId = values.request_id;
  if (!requestId || !procurementOptions.some(item=>item.id===requestId)) {
    addMessage("assistant","请选择有效的采购需求后再运行。",{error:true});
    return;
  }
  const payload = Object.fromEntries(new FormData($("run-form")));
  Object.assign(payload, {feature:selected.id,request_id:requestId});
  if (selected.id === "quote_delivery" || payload.shortage_source === "simulation") payload.scenario_token = latestScenario?.token;
  const localController = new AbortController();
  controller = localController;
  const selectedRequest = procurementOptions.find(item=>item.id===requestId);
  const label = (selectedRequest ? requestLabel(selectedRequest) : "本次断供采购需求") + " · " + selected.short;
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
      charts:result.charts,kpis:result.kpis,advice:result.advice,report:result.report,
      requestName:selectedRequest ? selectedRequest.company + "-" + selectedRequest.product : "采购需求"});
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
void loadRequestOptions();
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

